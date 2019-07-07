var _ = require('underscore')._;
_.mixin( require('toolbelt') );
var node_request = require('request');
var async = require('async');
var ObjTree = require('objtree');
var fs = module.require('fs');

// https://github.com/jahewson/node-byline
var byLine = require('byline');

// https://stuk.github.io/jszip/
var JSZip = require("jszip");

// https://github.com/mscdex/node-ftp
var Ftp = require('ftp');

// zip library used with ftp download.
var zlib = require('zlib');

var request = function(url, opts) {
	opts = _.defaults(opts || {}, {parseXML: false, force_array: [], full_response: false, raw: false, errorHandler: function() {}});
	var toJson;

	var makeRequest = function( method ) {
		return function(endpoint, options, callback) {
			if (_.isFunction(endpoint)) {
				callback = endpoint;
				endpoint = null;
				options = {};
			}
			
			if (_.isFunction(options)) {
				callback = options;
				options = endpoint;
				endpoint = null;
			}
			
			if (!_.isFunction(callback)) {
				callback = function(){};
			}
			
			url = !!endpoint ? [url, endpoint].join('/') : url;
			if (options && options.query) {
				url = url + '?' + require('querystring').stringify( options.query );
			}
			
			options = _.defaults(options, opts);
			return node_request(_.clean({
				url: url,
				method: method,
				json: true,
				body: options.body,
				auth: options.auth || opts.auth,
				headers: options.headers || opts.headers
			}), function(err, response) {

				// request can succeed but server issues failing statusCode.
				err = (err || (response && response.statusCode > 399)) 
				? ((response && response.statusCode) || err) 
				: null;

				if (err) {
					
					// return with the error and raw response object.
					return callback(err, response);
				}
				
				if (opts.raw || options.full_response) {
					
					// if raw just return with response.
					return callback(null, response)
				}

				if (opts.parseXML || options.parseXML) {
					
					if (!toJson) {
					    toJson = new ObjTree();
					   	toJson.force_array = options.force_array || opts.force_array;
					}
					
					// if parseXML set, then parse the body
					return callback(null, toJson.parseXML( response.body, {errorHandler: opts.errorHandler} ));
				}

				if (response && _.isFunction(response.toJSON)) {
					
					// server response includes method.
					response = response.toJSON();
				}
				
				// caller just wants the body of the response.
				callback(err, (response || {body: null}).body);			
			});			
		}
	};
	return({
		DELETE: makeRequest('DELETE'),
		POST: makeRequest('POST'),
		PUT: makeRequest('PUT'),
		GET: makeRequest('GET'),
		delete: makeRequest('DELETE'),
		post: makeRequest('POST'),
		put: makeRequest('PUT'),
		get: makeRequest('GET')
	});
};
exports.request = request;

var child_process = require('child_process');
var runCommand = function(commandStr, args, options, callback) {
	var child = child_process.spawn(commandStr, args)
	, result = '';
	
	parse = _.isFunction(options && options.parse) ? options.parse : function(x) {
		
		// not all stdout strings are well formed objects; 
		// the client may be looking for something like index 1 of '["log", "{"doc":{}}"]'
		try {
			return JSON.parse(x);
		}
		catch(e) {
			return x;
		}
	};
	
	// pipe child stdout to process.stdout; set encoding to text;
	if (options && options.pipe) {
		child.stdout.pipe(process.stdout, { end: false });
		child.stdout.setEncoding('utf8');
	}
	
	// capture stdout from child_process and look for the final 'doc' object; 
	child.stdout.on('data', function(data) {				
		result += data;
	});
	
	child.stdout.on('end', function() {		
		result = parse(result);		
	});

	// when command exits
	child.on('exit', function (code) {
		// execute the callback with the results from the workflow
		callback(code || 0, result);
	});
	return child;
};

var Download = function(obj, parent) {
	_.extend(this, obj);
	this.path = [parent.tmp || '/tmp', this.name].join('/');
	if (!this.fname && this.name) {
		this.fname = this.name.replace('.gz', '')
	}
	this._connection = parent;
	return this;
};

Download.prototype.gunzip = function(callback) {
	var self = this;
	
	if (this.name.split(/.gz/).length < 2) {
		console.log('[FTP] info: skipping...', this.name);
		return callback();
	}

	fs.createReadStream( this.path )
	.pipe( zlib.createGunzip() )
	.pipe( fs.createWriteStream( this.path.replace('.gz', '') )

		.on('close', function() {
			fs.unlink( self.path, callback);
		}) );

	return this;
};

Download.prototype.zipunzip = function(callback) {
	var self = this;
	
	// read a zip file
	fs.readFile(this._connection.zipname, function(err, data) {
	    if (err) throw err;
		
	    JSZip.loadAsync(data).then(function (zip) {
			
			zip
			.file( self.name )
			.nodeStream()
			.pipe(fs.createWriteStream( self.path ))
			.on('finish', function () {
			    // JSZip generates a readable stream with a "end" event,
			    // but is piped here in a writable stream which emits a "finish" event.
			    console.log('[ZIP/unzip] info: saved.', self.path);
				callback(null, self);
			})
			.on('error', function(err) {
				console.log('[ZIP/unzip] error:', err);
				callback(err);
			})
	    })
		.catch(function(err) {
			console.log('[ZIP/JSZip] error:', err);
			callback(err);
		})
	});
	return this;
};

Download.prototype.unzip = function() {
	return {
		ftp: Download.prototype.gunzip,
		zip: Download.prototype.zipunzip
	}[this._connection.protocol].apply(this, arguments);
};

Download.prototype.cleanup = function(callback) {
	var cleanupOne = function(path, next) {
		fs.stat(path, function(err, stats) {
			if (stats) {
				return fs.unlink( path, function(err) {
					next()
				});
			}
			return next()
		});	
	};
	
	return cleanupOne(this.path.replace('.gz', ''), callback);
};

Download.prototype.byLine = function() {
	return byLine( fs.createReadStream(this.path.replace('.gz', ''), { encoding: 'utf8' }) );
};

Download.prototype.readByLine = function(lineHandler, callback) {
	return this.byLine( this.path.replace('.gz', '') )
	.on('data', lineHandler.line)
	.on('error', callback)
	.on('end', function() {
		callback(null, lineHandler);
	});
};

Download.prototype.readXML = function(fname, options, callback) {
	if (typeof options === 'function') {
		callback = options;
		options = {};
	} else {
		options = options || {};
	}
	var toJson = new ObjTree();
	if (options.force_array) {
		toJson.force_array = options.force_array;				
	}

	fs.readFile(this.path.replace('.gz', ''), 'utf-8', function(err, data) {
		data = toJson.parseXML( data, _.clean({ errorHandler: options.errorHandler }));
		callback(err, data);
	});
};

var DownloadObjects = function( items, parent ) {
	var self = this;
			
	if (parent.protocol === 'zip') {
		this._files = _.keys(items.files).map(function(file) {
			return new Download( {fname: file, name: file, value: items.files[file]}, parent);
		});
		items._manifest = items.files;
		delete items.files;
	} else if (parent.protocol === 'ftp') {
		this._files = (items || []).map(function(item) {
			return new Download( item, parent );
		});
	} else {
		throw new Error('[DownloadObjects] fatal: Bad "protocol"');
	}
	this._connection = parent;
	return this;
};

DownloadObjects.prototype.files = function() {
	if ({ftp:true}[this._connection.protocol]) {
		return this._files.filter(function(item) {
			return !item.name.match(/.md5/) && !item.name.match(/.txt/);
		}).slice(0, this._connection.limit);		
	}
	return this._files.slice(0, this._connection.limit);
};

DownloadObjects.prototype.reverse = function() {
	this.files.reverse();
	return this;
};

DownloadObjects.prototype.each = function(fN, callback, context) {	
	async.eachLimit(DownloadObjects.prototype.files.apply(this), 1, _.bind(fN, context || this), callback);
	return this;	
};

DownloadObjects.prototype.unzipAll = function(callback) {
	this.each(function(item, next) {
		item.unzip(next);
	}, callback);
};

DownloadObjects.prototype.cleanup = function(callback) {
	var self = this;
	
	this.each(function(item, next) {
		item.cleanup(next);
	}, function(err) {
		if (err) return callback(err);
		
		if ({zip: true}[self._connection.protocol]) {
			return fs.unlink( self._connection.zipname, callback );
		}
		callback(null);
	});
};

var ZIP = function(config) {
	config = _.defaults(config || {}, {tmp: '/tmp', protocol: 'zip'});
	config.zipname = [config.tmp, config.fname].join('/');
	
	var stream = {
		protocol: 'zip',
		files: null,
		zipname: config.zipname,
		contents: function(callback) {
			var self = this;
						
			// read a zip file
			fs.readFile(this.zipname, function(err, data) {
			    if (err) throw new Error(err.message);
				
			    JSZip.loadAsync(data).then(function (zip) {
					self.manifest = new DownloadObjects(zip, self);
					return callback(null, self, self.manifest);
			    });
			});
		},
		get: function(callback) {
			var self = this;
			var file = fs.createWriteStream( config.zipname );
			
			node_request.get([config.hostname, config.path].join('/'), function(response) {
				console.log('Piping...');
			})
			.pipe( file )
			.on('error', function(err) {
				console.log('[stream] error:', err.message);
				callback(err);
			});

			file.on('finish', function() {
				file.close(function() {
					console.log('Final close.');
					callback(null, self);
				}); // close() is async, call cb after close completes.
			});

			return this;
		}
	};
	return stream;
};

var FTP = function(config) {
	config = _.defaults(config || {}, {verbose: false, protocol: 'ftp'});

	return {
		protocol: 'ftp',
		path: config.path,
		tmp: config.tmp || '/tmp',
		limit: config.limit,
		files: null,
		downloaded: [],
		open: function(response) {
			this.end();
			return this.contents( config.path, response);
		},
		contents: function(response) {
			var self = this;
			var c = self._c = new Ftp();

			if (config.verbose) console.log('[FTP] info: ', config.host, config.path);
			c.on('ready', function() {
				
				async.auto({
					cwd: function(next) {
						c.cwd(config.path, next);
					},
					pwd: ['cwd', function(next) {
						c.pwd(next);
					}],
					list: ['pwd', function(next, data) {
						if (data.pwd.slice(1) !== config.path) response('PWD Failed.');
						c.list(function(err, ftplist) {
							if (err) { c.end(); }
							self.manifest = new DownloadObjects( ftplist, self );
							response(err, self);
						});
					}]
				});
			});
			
			// connect
			c.connect( _.pick(config, 'host', 'password' ) );
			return this;			
		},
		
		get: function(ftpItem, next) {
			var self = this;
			
			if (ftpItem.name.indexOf('.md5') !== -1) {
				return process.nextTick( next );
			}
			
			if (config.verbose) console.log('[FTP] info: downloading...', ftpItem.name);
			this._c.get(ftpItem.name, function(err, stream) {
				if (err) throw err;
				stream
				.once('close', function(err) {
					self.downloaded.push( ftpItem.name );
					next(err);
				})
				.pipe(fs.createWriteStream([config.tmp, ftpItem.name].join('/')));
			});
			return this;
		},
		
		end: function() {
			this._c.end();
		}
	}
};

module.exports = {
	request: request,
	command: runCommand,
	Download: Download,
	FTP: FTP,
	ZIP: ZIP
};




