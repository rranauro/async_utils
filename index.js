var _ = require('underscore')._;
_.mixin( require('base-utils') );

var request = require('request');
var async = require('async');
var ObjTree = require('objtree');
var fs = module.require('fs');
var moment = require('moment');
var qs = require('querystring');

exports.timeStamp = function() {
	var tags = {}
	
	return({
		start: function(tag) {
			this.time(tag);
			return this;
		},
		time: function(tag, reset) {
			if (!tags[tag] || reset) {
				tags[tag] = Date.now()
			}
			return Math.round((Date.now() - tags[tag]) / 1000).toFixed(2);
		},
		timeEnd: function(tag) {
			var end = this.time(tag);
			delete tags[tag];
			return end;
		}
	});
};

exports.bulkSave = function(settings, options) {
	options = _.defaults(options || {}, {silent: false});
	return function(json, callback) {
		var total_docs = 0;
	
		async.eachLimit(_.range(0, json.length, 1000), 5, function(start, callback) {
			request.post({
				url: [settings.db, '_bulk_docs'].join('/'),
				json: true,
				body: { docs: json.slice(start, start + 1000) }
			}, function(err, response) {					
				var errors;
				total_docs += (_.where((response && response.body || []), {ok: true})).length;
				if (err || !options.silent) {
					errors = _.chain(response.body)
					.groupBy(function(doc) { return doc.reason ? doc.reason : 'ok' })
					.map(function(values, group) {
						return({error: values[0].error, reason: group, count: values.length});
					})
					.value()[0];
										
					console.log('Error:', err, 'Status:', errors.error 
					? _.sprintf('%s, %s: %d', errors.error, errors.reason, errors.count)
					: _.sprintf('ok: %d', errors.count), 'Total:', total_docs);
				}
				callback(err, errors);
			});
		}, callback);	
	};	
};

var _request = function(settings, opts) {
	opts = _.defaults(opts || {}, {parseXML: false, force_array: []});
	var toJson;
	
	if (opts.parseXML) {
	    toJson = new ObjTree();
	   	toJson.force_array = opts.force_array;
	}

	var makeRequest = function( method ) {
		return function(url, options, callback) {
			if (_.isFunction(url)) {
				callback = url;
				url = null;
				options = {};
			}
			url = options.url || settings && settings.db && [settings.db, url].join('/') || url && settings && [settings, url].join('/') || settings;
			if (!url || url && typeof url === 'object') throw new Error('bad "url"');
			
			if (_.isFunction(options)) {
				callback = options;
				options = {};
			}
			
			if (options.query) {
				options.query = require('querystring').encode( options.query );
				url = url + '?' + options.query;
			}
			return request(_.clean({
				url: url,
				method: method,
				json: true,
				body: options.body,
				auth: opts.auth,
				headers: options.headers || opts.headers
			}), function(err, response) {
				if (err) return callback(err, response);
				callback(null, opts.parseXML ? toJson.parseXML( response.body ) : response.body);			
			});			
		}
	}
	return({
		delete: makeRequest('DELETE'),
		post: makeRequest('POST'),
		put: makeRequest('PUT'),
		get: makeRequest('GET')
	});
};
exports.request = _request;

exports.cleanDoc = function(doc) {
	var cleanString = function(input) {
	    var output = "";
		
		if (typeof input === 'string') {
		    for (var i=0; i<input.length; i++) {
		        if (input.charCodeAt(i) <= 127) {
		            output += input.charAt(i);
		        }
	    	}
	    	return output;			
		}
		return input;
	};
			
	return _.reduce(doc, function(result, value, key) {
		if (_.isString(value)) {
			result[key] = cleanString( value );			
		} else if (_.isArray(value)) {
			result[key] = value.map(cleanString);
		} else if (_.isObject(value)) {
			result[key] = exports.cleanDoc( value );
		}
		return result;
	}, doc);
};

var bulk = function( op ) {
	return function(settings, _view, transform) {
		var db = settings.getHostInfo('db');
		var _ddoc = settings.getHostInfo('ddoc');
		var callback = arguments[arguments.length-1];

		async.waterfall([
		
			function(callback) {
			
				// query the view and get _id/_rev info
				_request(settings.getHostInfo()).get('_design/lifescience/_list/alldocs/collections', {
					query: {
						reduce: false, 
						collection: _view, 
						startkey: JSON.stringify([_view]), 
						endkey: JSON.stringify([_view,{}])
					}}, callback);
			},

			// fetch the 'removeView' list; returns array of objects marked "_deleted"
			function(data, callback) {
			
				if (data && data.error || data && data.code > 399) {
					console.log('[ util ] error:', data.error, data.reason || data.message);
					return callback(data);
				}
			
				if (op == 'remove') console.log('Removing', data.length);
				if (op == 'update') console.log('Updating', data.length);
				if (op == 'update' && _.isFunction(transform)) {
					data = transform( data );
				}
				exports.bulkSave(settings.getHostInfo())(data, arguments[arguments.length-1]);
			}
		], function(err) {
			console.log('Remove done', !err ? 'success' : err);
			callback(err);
		});
	};
}

exports.remove = bulk( 'remove' );
exports.update = bulk( 'update' );


var child_process = require('child_process');
var runCommand = function(commandStr, args, options, callback) {
	var build = child_process.spawn(commandStr, args)
	, result = '';
	
	parse = _.isFunction(options && options.parse) ? options.parse : function(x) {
		
		// not all stdout strings are well formed objects; 
		// the client is looking for something like index 1 of '["log", "{"doc":{}}"]'
		try {
			return JSON.parse(x)[1];
		}
		catch(e) {
			return {};
		}
	};
	
	// pipe child stdout to process.stdout; set encoding to text;
	if (options && options.pipe) {
		build.stdout.pipe(process.stdout, { end: false });
		build.stdout.setEncoding('utf8');
	}
	
	// capture stdout from child_process and look for the final 'doc' object; 
	build.stdout.on('data', function(data) {				
		result += data;
	});
	
	build.stdout.on('end', function() {		
		result = parse(result);		
	});

	// when command exits
	build.on('exit', function (code) {
		// execute the callback with the results from the workflow
		callback(code || 0, result);
	});
	return build;
};
exports.runCommand = runCommand;

var pipelineCollection = function( settings, context ) {
	var _collection = []
	, totalSaved = 0
	, id = _.uniqueId()
	, timer = exports.timeStamp().start(id)
	, options = context.drain;
	
	_collection.toJSON = function() {
		return this.slice(0);
	};
	
	_collection.ok = function() {
		return !!this.length;
	};
	
	_collection.add = function( obj ) {
		if (_.isArray(obj)) {
			_.each(obj, function(item) {
				this.push( item );
			}, _collection);
			return this;
		}
		_collection.push( obj );
		return this;		
	};
	
	_collection.reset = function() {
		this.length = 0;
	};
	
	_collection.save = function(callback) {
		if (this.ok()) {
			totalSaved += this.length;
			console.log( _.template(this.message_template)({
				module: options.module || 'pipeline',
				id: id,
				saving: this.length,
				total_saved: totalSaved,
				elapsed: timer.time( id ),
				docs_per_second: Math.round(totalSaved/(timer.time( id ))).toFixed(2),
				memory: _.memory()
			}) );
		
			// save the models;
			return exports.bulkSave(settings, {silent: true})(this.toJSON(), callback);
		} else if (_collection.length) {
			return callback({error: 'collection_not_ok'});
		}
		callback(null, {message: 'nothing_to_save'});
	}
	_collection.message_template = '[ pipeline ] [thread <%= id %>] Bulk saving (<%= saving %>), total saved (<%= total_saved %>), elapsed (<%= elapsed %>), docs/s (<%= docs_per_second %>), memory (<%= memory %>)';

	// allow the user to inject these methods on the drain;
	_.extend(_collection, _.pick(options || {}, 'save', 'toJSON', 'ok', 'add'));
	_collection.context = context;
	return _collection;	
};

var readRequest = function( settings, options) {
	var that = {} 
	, totalSaved = 0
	, id = _.uniqueId('thread')
	, _collection = pipelineCollection( settings, options )
	, read = function(callback, count) {
		let self = this;
		
		request({
			url: this.url,
			json: true,
			method: this.method || 'GET',
			body: this.method === 'POST' ? this.body : undefined,
			headers: this.headers
		}, _.bind(function(err, response) {
		
			if (err) {
				if (response && response.statusCode && response.statusCode === 404) {
					console.log(_.sprintf('[%s] error: "%s"', id, response.statusMessage));
					return callback();
				}
				if (!response) {
					console.log(_.sprintf('[%s] error: "%s"', id, err.message));
					return callback();
				}
				callback(err);
			}
			
			// Service Unavailable, Too Many Connections
			if (response && response.statusCode === 503) {
				if (count === 10) {
					console.log(_.sprintf('[%s] error: "too many retries"', id));
					return callback({error: 'read_failed', reason: 'too_many_retries'});
				}
	
				return _.wait((0.25 * count || 1), function() {
					console.log(_.sprintf('[%s] fetch error: %s, retries (%d)', 
						id, response.statusMessage || response.statusCode, count || 1));
					read.call(self, callback, count ? count + 1 : 2);
				});
			}
			
			if (response && response.body) {
				
				// parse the results
				this.parse( response.body );
		
				if (_.result(this, 'ok')) {
					_collection.add( this.toJSON() );
					this.destroy()
				} else {
					if (this.error) {
						console.log(_.sprintf('[pipeline] warning: error: "%s", reason: "%s"', this.error, this.reason || this.error));
					}
				}				
				return callback(); 					
				
			}
			callback(null, {error: 'read_failed', reason: 'missing_body'}); 					
		}, this));
	};
	
	that.read = function(query, callback) {
		_.defaults(query || {}, {
			parse: function(data) {
				this.attributes = data;
				return this.attributes;
			},
			toJSON: function() {
				return this.attributes;
			},
			ok: true,
			destroy: _.bind(function() {
				_.each(['ok','parse', 'attributes', 'toJSON', 'url'], function(key) {
					delete this[key];
				}, this);
			}, query)
		});
		
		if (_.isFunction(query.read)) {
			return query.read.call(query, function() {
				if (_.result(query, 'ok')) {
					_collection.add( query.toJSON() );
					query.destroy()
					callback();
				}
			});
		}
		return read.call(query, callback );		
	};
	
	that.reset = function() {
		_collection.reset();
		return this;		
	};
	
	that.save = _.bind(_collection.save, _collection);
	return that;
};


var pipeline = function(settings) {
	
	var go = function(options) {
		var threads
		, chunks;
		
		options = _.defaults(options, {
			drain: pipelineCollection,
			source: readRequest,
			threads: 1,
			bucketSize: 1,
			callback: function(){}
		})
		var thread = function(chunk, threadFinish) {
		
			// we re-use the same reqRequest / collection over and over for each operation on this thread.
			// that way, we recycle memory without generating new collections every time.
			var readReq = options.source( settings, options );

			// process one bucket
			async.eachLimit(_.range(0, chunk.length, options.bucketSize), 1, function(start, continue_processing) {
				readReq.reset();

				// fetch from server one simultaneous read per bucket;
				async.eachLimit(chunk.slice(start, start + options.bucketSize), 1, readReq.read, function() {
					readReq.save(continue_processing);
				});
			}, threadFinish);
		}

		// compute the start index of each thread and return the array slice
		threads = options.queries.length > options.threads ? options.threads : options.queries.length; 
		chunks = _.map(_.range(0, options.queries.length, (options.queries.length / threads)), 
				function(start) {
			return options.queries.slice(start, start + (options.queries.length / threads));
		});

		// parallelism is determined by the number of "chunks". 
		// Each chunk runs serially internally
		async.each(chunks, function(job, finish) {
			_.wait(Math.random(), function() { thread( job, finish); });
		}, function(err, response) {
			if (response && response.error) {
				console.log('[pipeline] warning:', response.errror, response.reason);
				err = _.pick(response, 'error', 'reason');
			}
			options.callback(err, options);
		}); 
	};
	
	return({
		drain: pipelineCollection,
		source: readRequest,
		go: go
	});
};

var readRequest = function( settings, options, collection) {
	var that = {} 
	, totalSaved = 0
	, id = _.uniqueId()
	, timer = exports.timeStamp().start(id)
	, read = function(callback, count) {
		let self = this;
		
		request({
			url: this.url,
			json: true,
			method: this.method || 'GET',
			body: this.method === 'POST' ? this.body : undefined,
			headers: this.headers
		}, _.bind(function(err, response) {
		
			if (err) {
				if (response && response.statusCode && response.statusCode === 404) {
					console.log(_.sprintf('[%s] error: "%s"', id, response.statusMessage));
					return callback();
				}
				if (!response) {
					console.log(_.sprintf('[%s] error: "%s"', id, err.message));
					return callback();
				}
				callback(err);
			}
			
			// Service Unavailable, Too Many Connections
			if (response && response.statusCode === 503) {
				if (count === 10) {
					console.log(_.sprintf('[%s] error: "too many retries"', id));
					return callback({error: 'read_failed', reason: 'too_many_retries'});
				}
	
				return _.wait((0.25 * count || 1), function() {
					console.log(_.sprintf('[%s] fetch error: %s, retries (%d)', 
						id, response.statusMessage || response.statusCode, count || 1));
					read.call(self, callback, count ? count + 1 : 2);
				});
			}
			
			if (response && response.body) {
				
				// parse the results
				return callback(null, this.parse( response.body ) );
			}
			callback(null, {error: 'read_failed', reason: 'missing_body'}); 					
		}, this));
	};
	
	that.read = function(query, callback) {
		query = _.defaults(query || {}, {
			parse: function(data) {
				this.attributes = data;
				return this.attributes;
			},
			toJSON: function() {
				return this.attributes;
			},
			ok: true,
			collection: this.collection,
			destroy: _.bind(function() {
				_.each(['ok','parse', 'attributes', 'toJSON', 'url'], function(key) {
					delete this[key];
				}, this);
			}, query)
		});
		
		let onRead = _.bind(function() {
			if (_.result(query, 'ok')) {
				this.add( query.toJSON() );
				query.destroy()
				callback.apply(this);
			}
		}, this);
		
		if (_.isFunction(query.read)) {
			query.read.call(query, onRead);
		} else {
			read.call(query, onRead);
		}
		return this;		
	};
	
	that.collection = collection;
	that.processed = collection.slice(0);
	that.add = function( obj ) {
		obj = _.isArray(obj) ? obj : [ obj ];
		this.collection = this.collection.concat( obj );
		return this;		
	};
	
	that.reset = function() {
		this.processed = this.processed.concat( this.collection );
		this.collection.length = 0;
	};
	
	that.toJSON = function() {
		return this.collection.slice(0);
	};
	
	that.ok = function() {
		return !!this.collection.length;
	};
	
	that.bulkReady = function() {
		return (this.ok() && this.collection.length >= options.bucketSize)
	};
	
	that.save = function(docs, callback) {
		if (docs.length) {
			totalSaved += this.collection.length;
			console.log( _.template(this.message_template)({
				module: options.module || 'pipeline',
				id: id,
				saving: this.length,
				total_saved: totalSaved,
				elapsed: timer.time( id ),
				docs_per_second: Math.round(totalSaved/(timer.time( id ))).toFixed(2),
				memory: _.memory()
			}) );
		
			// save the models;
			return exports.bulkSave(settings, {silent: true})(docs, callback);
		} 
		callback(null, {message: 'nothing_to_save'});
	}
	that.message_template = '[ pipeline ] [thread <%= id %>] Bulk saving (<%= saving %>), total saved (<%= total_saved %>), elapsed (<%= elapsed %>), docs/s (<%= docs_per_second %>), memory (<%= memory %>)';

	// allow the user to inject these methods on the drain;
	that.save = options && options.drain && options.drain.save || that.save;
	that.context = options;
	return that;
};


var pipeline = function(settings) {
	
	var go = function(options) {
		var threads
		, chunks
		, queue
		, collection = [];
		
		options = _.defaults(options, {
			source: readRequest,
			threads: 1,
			bucketSize: 1,
			callback: function(){}
		})
		
		var readReq = options.source( settings, options, collection )
		var handleOne = function(query, callback) {
			
			// we re-use the same reqRequest / collection over and over for each operation on this thread.
			// that way, we recycle memory without generating new collections every time.
			readReq.read(query, function() {
				let docs;
				
				if (this.bulkReady()) {
					docs = this.toJSON();
					this.reset();
					return readReq.save(docs, callback);
				}
				callback();
			});
		};
		
		queue = async.queue( handleOne, threads );
		queue.drain = function() {
			readReq.save( readReq.toJSON(), function() {
				readReq.reset();
				options.callback(null, readReq);
			});
		};
		
		options.queries.forEach(function(query) {
			queue.push( query, function(err, response) {
				if (response && response.error) {
					console.log('[pipeline] warning:', response.errror, response.reason);
					err = _.pick(response, 'error', 'reason');
					
				}
			});
		});
	};
	
	return({
		drain: pipelineCollection,
		source: readRequest,
		go: go
	});
};


exports.pipeline = pipeline;

