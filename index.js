var _ = require('base-utils')._;
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
	
		async.mapLimit(_.range(0, json.length, 1000), 5, function(start, next) {
			request.post({
				url: [settings.db, '_bulk_docs'].join('/'),
				json: true,
				body: { docs: json.slice(start, start + 1000) }
			}, function(err, response) {					

				if (err) {
					
					// Request error, no fallback
					return next(err);
				}
				
				// Update semantics, fallback with diagnostics
				total_docs += (_.where((response && response.body || []), {ok: true})).length;
				let errors = _.chain(response && response.body || [])
				.groupBy(function(doc) { return doc.reason || 'ok' })
				.map(function(values, group) {
					return({error: values[0].error, reason: group, count: values.length, ok: group === 'ok'});
				})
				.value();
				
				if (!options.silent) {
					errors.forEach(function(error) {
						if (error.ok) {
							console.log(_.sprintf('Success: %d, Total: %d', error.count, total_docs)); 								
						} else {
							console.log(_.sprintf('Error: %s, Reason: %s, Total: %d', error.error, error.reason, error.count)); 
						}
					});
				}
				next(null, response.body);
			});
		}, function(err, jobs) {
			callback(err, _.flatten(jobs));
		});	
	};	
};

var _request = function(settings, opts) {
	opts = _.defaults(opts || {}, {parseXML: false, force_array: [], full_response: false});
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
			
			if (_.isFunction(options)) {
				callback = options;
				options = {};
			}
			
			if (!_.isFunction(callback)) {
				callback = function(){};
			}
			
			url = (options && options.url) || (settings && settings.db && [settings.db, url].join('/')) || (url && settings && [settings, url].join('/')) || settings;
			if (!url || url && typeof url === 'object') throw new Error('bad "url"');
			
			if (options && options.query) {
				options.query = require('querystring').encode( options.query );
				url = url + '?' + options.query;
			}
			
			options = _.defaults(options, opts);
			return request(_.clean({
				url: url,
				method: method,
				json: true,
				body: options && options.body,
				auth: opts.auth,
				headers: options && options.headers
			}), function(err, response) {
				if (response && _.isFunction(response.toJSON)) {
					response = response.toJSON();
				}
				if (!err && options.parseXML) {
					return callback(null, toJson.parseXML( response.body ));
				}
				err = err || (response && response.statusCode > 399) ? (response && response.statusCode) || err : null;
				callback(err, options.full_response ? response : (response || {body: null}).body);			
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
	return function(settings, _collection, transform) {
		var db = settings.getHostInfo('db');
		var _ddoc = settings.getHostInfo('ddoc');
		var callback = arguments[arguments.length-1];
		var docs;
		
		if (op === 'update' && _.isArray(_collection)) {
			docs = _.reduce(_collection, function(result, doc) {
				if (typeof doc === 'object' && doc._id) {
					result[doc._id] = doc;
				}
				return result;
			}, {});
			_collection = _.keys(docs);
		}

		async.waterfall([
		
			// index query using "collection" _view; or keyed using _all_docs
			function(callback) {
				let url = _.isArray(_collection) ? '_all_docs' : '_design/lifescience/_list/alldocs/collections';
				let query = _.isArray(_collection)
				? undefined
				: {
					reduce: false, 
					collection: _collection, 
					startkey: JSON.stringify([_collection]), 
					endkey: JSON.stringify([_collection,{}])
				};
				
				if (_.isArray(_collection)) {
					async.mapLimit(_.range(0, _collection.length, 10000), 1, function(start, next) {
						
						// query the view and get _id/_rev info
						_request(settings.getHostInfo()).post(url, _.clean({
							body: {keys: _collection.slice(start, start + 10000)}
						}), function(err, response) {
							console.log('[util] info:', response && response.rows && response.rows.length || 'no_response');
							next(err, response && response.rows && response.rows.slice(0))
						});
						
					}, function(err, docs) {
						callback(err, _.flatten(docs));
					});
					
				} else {
					
					// query the view and get _id/_rev info
					_request(settings.getHostInfo()).get(url, _.clean({
						query: query, 
					}), function(err, response) {
						callback(err, response.rows.slice(0));
					});					
				}
			},

			// fetch the 'removeView' list; returns array of objects marked "_deleted"
			function(data, callback) {
			
				if (data && data.error || data && data.code > 399) {
					console.log('[ util ] error:', data.error, data.reason || data.message);
					return callback(data);
				}
				
				if (data && data.length) {
					if (op === 'remove') {
						data = data.map(function(row) {
							return {_id: row.id, _rev: row.value.rev, _deleted: true};
						});
					} else {
						
						// create or update
						data = data.map(function(row) {
							let doc = docs[row.key];
							if (row.value && row.value.rev) {
								doc._rev = row.value.rev;
							}
							return doc;
						});
					}
				}
			
				if (op == 'remove') console.log('Removing', data.length);
				if (op == 'update') console.log('Updating', data.length);
				if (op == 'update' && _.isFunction(transform) && transform !== callback) {
					data = transform( data );
				}
				exports.bulkSave(settings.getHostInfo())(data, callback);
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

var readRequest = function( settings, options, collection) {
	var that = {} 
	, totalSaved = 0
	, id = _.uniqueId()
	, timer = exports.timeStamp().start(id)
	, read = function(callback, count) {
		let self = this;
		
		if (options.request_timer) {
			console.time(this.url);
		}
		request(_.clean({
			url: this.url,
			json: true,
			method: this.method || 'GET',
			body: this.method === 'POST' ? this.body : undefined,
			timeout: options.timeout,
			headers: this.headers
		}), _.bind(function(err, response) {
		
			if (options.request_timer) {
				console.timeEnd(this.url);
			}
			
			if (err) {
				if (response && response.statusCode && response.statusCode === 404) {
					console.log(_.sprintf('[%s] error: "%s"', id, response.statusMessage));
					return callback(null, {error: 404, reason: response.statusMessage});
				}
				if (!response) {
					console.log(_.sprintf('[%s] error: "%s"', id, err.message));
					return callback(null, {error:'empty_response', reason: err.message || 'empty_response'});
				}
				callback(null, err);
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
				return callback(null, this.parse( response.body, options ) );
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
		
		let onRead = _.bind(function(err, response) {
			if (response && !response.error && _.result(query, 'ok')) {
				this.add( query.toJSON() );
			}
			query.destroy()
			callback.apply(this);
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
		
		// filter elements with no keys
		obj = obj.filter(function(doc) { return _.keys(doc).length; });
		
		this.collection = this.collection.concat( obj );
		return this;		
	};
	
	that.reset = function() {
		this.processed = this.processed.concat( this.collection
			.filter(function(doc) { return typeof doc === 'object'; 
		}).map(function(doc) {
			return _.pick(doc, '_id', 'parseError');
		}) );
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
		self = this;
		
		if (docs.length) {
			totalSaved += docs.length;
			console.log( _.template(this.message_template)({
				module: options.module || 'pipeline',
				id: id,
				saving: docs.length,
				total_saved: totalSaved,
				elapsed: timer.time( id ),
				docs_per_second: Math.round(totalSaved/(timer.time( id ))).toFixed(2),
				memory: _.memory()
			}) );
		
			// save the models;
			return exports.bulkSave(settings, {silent: !!options.silent})(docs, function(err, response) {
				if (!options.processed) self.processed.length = 0; 
				self.onSave( docs, response );
				callback(null, {total_processed: self.processed.length});
			});
		} 
		callback(null, {total_processed: self.processed.length});
	}
	that.message_template = '[ pipeline ] [thread <%= id %>] Bulk saving (<%= saving %>), total saved (<%= total_saved %>), elapsed (<%= elapsed %>), docs/s (<%= docs_per_second %>), memory (<%= memory %>)';

	// allow the user to inject these methods on the drain;
	that.save = options && options.drain && options.drain.save || that.save;
	that.onSave = options && options.drain && options.drain.onSave || function(){};
	that.context = options;
	return that;
};


var pipeline = function(settings) {
	
	var go = function(options) {
		var threads
		, chunks
		, queue
		, collection = []
		, jobs = 0;
		
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
				
				jobs += 1;
				if (options.job_status && !(jobs % 100)) console.log('[pipeline] info: jobs completed', jobs);
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
			readReq.save( readReq.toJSON(), function(err, response) {
				readReq.reset();
				options.callback(null, readReq, response);
			});
		};
		
		if (options.queries.length) {
			options.queries.forEach(function(query) {
				queue.push( query, function(err, response) {
					if (response && response.error) {
						console.log('[pipeline] warning:', response.errror, response.reason);
						err = _.pick(response, 'error', 'reason');
					
					}
				});
			});
		} else {
			options.callback();
		}

	};
	
	return({
		go: go
	});
};


exports.pipeline = pipeline;

