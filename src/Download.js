var _ = require('underscore')._;
_.mixin( require('toolbelt') );
var node_request = require('request');
var async = require('async');
var ObjTree = require('objtree');
var fs = module.require('fs');

var Download = function(obj, parent) {
	parent = _.defaults(parent || {}, {protocol: 'ftp', tmp: '/tmp'});
	
	_.extend(this, obj);
	this.path = [parent.tmp || '/tmp', this.name].join('/');
	this.directory = this.path.split('/').length > 1
	? this.path.split('/').slice(0, this.path.split('/').length-1).join('/')
	: '';
	
	if (!this.fname && this.name) {
		this.fname = this.name.replace('.gz', '')
	}
	this.protocol = parent.protocol;
	if ({zip: true}[this.protocol]) {
		this.zipname = parent.zipname;
	}
	return this;
};

Download.prototype.unlink = function() {
	delete this.zipObject;
	return this;
};

Download.prototype.gunzip = function(callback) {
  // zip library used with ftp download.
  var zlib = require('zlib');
	var self = this;
	
	if (this.name.split(/.gz/).length < 2) {
		console.log('[FTP] info: skipping...', this.name);
		setTimeout(function() {
			callback({code: 'unprocessable_entity', status: 403, message: 'Not a ".gz" file.'});
		}, 100);
	} else {
		fs.createReadStream( self.path )
		.pipe( zlib.createGunzip() )
		.pipe( fs.createWriteStream( self.path.replace('.gz', '') )

			.on('close', function() {
				fs.unlink( self.path, callback);
			}) );		
	}
	return this;
};

const _zipunzip = function(callback) {
	var self = this;
	
	var writable = fs.createWriteStream( self.path );
	// read a zip file
	this.JSZip
	.file( self.name )
	.nodeStream()
	.pipe( writable )
	.on('finish', function () {
	    // JSZip generates a readable stream with a "end" event,
	    // but is piped here in a writable stream which emits a "finish" event.
	    if (self.verbose) console.log('[ZIP/unzip] info: saved.', self.name);
		self.unzipped = true;
		writable.end();
		callback(null, self);
	})
	.on('error', function(err) {
		console.log('[ZIP/unzip] error:', err);
		callback(err);
	})
	return this;
};

Download.prototype.zipunzip = function(callback) {
	var self = this;
	
	if (this.inflate) {
		if (this.directory) {
			fs.mkdir(this.directory, function(err) {
				if (err && err.code !== "EEXIST") {
					throw new Error('[Download] fatal: "mkdir" failed not existing.')
				}
				_zipunzip.call(self, callback);					
			});	
		} else {
			_zipunzip.call(self, callback);		
		}		
	} else {
		this.JSZip.file(this.name).async("string").then(function (data) {
			self.unzipped = true;
			callback(null, data);
		}, callback);		
	}
	return this;
};

Download.prototype.unzip = function() {
	return {
		ftp: Download.prototype.gunzip,
		zip: Download.prototype.zipunzip
	}[this.protocol].apply(this, arguments);
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
	
	if (this.unzipped && this.inflate) {
		return cleanupOne(this.path.replace('.gz', ''), callback);		
	}
	// delete this.JSZip.files[this.name]
	process.nextTick(callback);
};

Download.prototype.byLine = function() {
  // https://github.com/jahewson/node-byline
  var byLine = require('byline');
  
	return byLine( fs.createReadStream(this.path.replace('.gz', ''), { encoding: 'utf8' }) );
};

Download.prototype.readByLine = function(lineHandler, callback) {
	var self = this;
	
	return this.byLine( this.path.replace('.gz', '') )
	.on('data', lineHandler.line)
	.on('error', callback)
	.on('end', function() {
		callback(null, self, lineHandler);
	});
};

Download.prototype.readXML = function(options, callback) {
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

var DownloadObject = function( items, config ) {
	var self = this;
			
	config = _.extend({}, _.defaults(config || {}, {
		tmp: '/tmp', 
		limit: undefined, 
		downloaded: config.protocol == 'ftp' ? [] : false, 
		verbose:false,
		concurrency: 1,
		inflate: true
	}), {
		
		// use the 'protocol' value (ftp or zip) to decode this object for the parameters we want.
		ftp: {
			protocol: 'ftp',
			open: function(response) {
        // https://github.com/mscdex/node-ftp
        var Ftp = require('ftp');
				var c = new Ftp();
				
				c.on('error', function(err) {
					console.log('[FTP] error:', err && err.code || err);
					response(err);
				});
				
				c.on('ready', function() {
					async.auto({
						cwd: function(next) {
							c.cwd(config.path, next);
						},
						pwd: ['cwd', function(next) {
							c.pwd(next);
						}],
						response: ['pwd', function(next, data) {
							if (data.pwd.slice(1) !== config.path) {
								throw new Error('Unable to connect, PWD Failed.');
							}
							response( c );
						}]
					});		
				});
				
				_.wait(2 * Math.random(), function() {
					c.connect( _.pick(config, 'host', 'password' ) );					
				});
			
				return this;
			},
			contents: function(response) {
				var self = this;
				var c = new Ftp();

				if (config.verbose) console.log('[FTP] info: ', config.host, config.path);
				this.open(function(connection) {
					
					if (connection && connection.list) {
						return connection.list(function(err, ftplist) {
							connection.end();
							response(err, self.add( ftplist ));
						});							
					}
					
					// return an error
					response(connection);
				});
				return this;			
			},
		
			get: function(ftpItem, next) {
				var self = this;
				
				if (config.verbose) console.log('[FTP] info: downloading...', ftpItem.name);
				this.open(function(connection) {
					connection.get(ftpItem.name, function(err, stream) {
						if (err) {
							connection.end();
							if (config.verbose) console.log('[FTP] error: streaming...', err.message);							
							return next(err);
						};
						
						stream
						.once('close', function(err) {
							self.downloaded.push( ftpItem.name );
							connection.end();
							next(err);
						})
						.pipe(fs.createWriteStream( ftpItem.path ));
					});					
				});
				return this;
			}		
		},
		zip: {
			protocol: 'zip',
			zipname: config.zipname,
			contents: function(callback) {
				var self = this;
        
        // https://stuk.github.io/jszip/
        var JSZip = require("jszip");
				
				async.auto({
					fetch: function(next) {
						self.get(next);
					},
					handle: ['fetch', function(next, data) {
						
						// read a zip file
						fs.readFile(self.zipname, function(err, data) {
						    if (err) throw new Error(err.message);
				
						    new JSZip().loadAsync(data).then(function (zip) {
								return callback(null, self.add( zip ));
						    });
						});						
					}]
				});
			},
			get: function(callback) {
				
				if (this.downloaded) {
					_.wait(1, function() {
						callback(null, this);
					}, this);
					return this;
				}
				
				var self = this;
				var file = fs.createWriteStream( config.zipname );
				node_request.get({
					uri: [config.hostname, config.path].join('/'),
					encoding: null
				}, function(response) {
					if (config.verbose) console.log('[ZIP] info: Piping...');
				})
				.pipe( file )
				.on('error', function(err) {
					console.log('[ZIP] error:', err.message);
					callback(err);
				});

				file.on('finish', function() {
					file.close(function() {
						if (config.verbose) console.log('[ZIP] info: Finished Piping.');
						self.downloaded = true;
						callback(null, self);
					}); // close() is async, call cb after close completes.
				});

				return this;
			}			
		}
	}[config.protocol || 'zip']);
  _.each(config, function(value, key) {
    this[key] = value;
  }, this);
  
  if (items && items.length) {
    DownloadObject.prototype.add.call(this, items);
  }
	return this;
};

DownloadObject.prototype.addOne = function(file, zipObject) {
	return new Download( {
		fname: _.last(file.split('/')), 
		name: file, 
		JSZip: zipObject,
		verbose: this.verbose,
		inflate: this.inflate
	}, this);
};

DownloadObject.prototype.add = function(zipObject) {
	var self = this;
	
	if (zipObject && zipObject.files && this.protocol === 'zip') {
		this._files = _.keys(zipObject.files).map(function(file) {
			return self.addOne(file, zipObject);
		});
		this._index = _.firstIndexByKey(this._files, 'fname');
	} else if (zipObject && this.protocol === 'ftp') {
		this._files = (zipObject || []).map(function(item) {
			return new Download( item, self );
		});
	}
	return this;
};

DownloadObject.prototype.files = function() {
	if ({ftp:true}[this.protocol]) {
		return this._files.filter(function(item) {
			return !item.name.match(/.md5/) && !item.name.match(/.txt/);
		}).slice(0, this.limit);		
	}
	return this._files.slice(0, this.limit);
};

DownloadObject.prototype.length = function() {
	return this.files().length;
};

DownloadObject.prototype.reverse = function() {
	this.files.reverse();
	return this;
};

DownloadObject.prototype.each = function(fN, callback, context) {	
	async.eachLimit(DownloadObject.prototype.files.apply(this), this.concurrency, _.bind(fN, context || this), callback);
	return this;	
};

DownloadObject.prototype.unzipAll = function(handler, callback) {
	this.each(function(item, next) {
		item.unzip(function(err) {
			if (!err && handler) {
				return handler.call(item, next);
			}
			next();
		});
	}, callback);
};

DownloadObject.prototype.cleanup = function(callback, keep) {
	var self = this;
	
	this.each(function(item, next) {
		item.cleanup(next);
	}, function(err) {
		if (err) return callback(err);
		
		if ({zip: true}[self.protocol]) {
      
  		self._files = {};
      self._index = {}
			if (!keep) return fs.unlink( self.zipname, callback );
		}
		callback(null);
	});
};

var ZIP = function(config) {
	config = _.defaults(config || {}, {tmp: '/tmp', verbose: false, protocol: 'zip'});
	config.zipname = [config.tmp || '/tmp', config.fname].join('/');
	return new DownloadObject(null, config);
};

var FTP = function(config) {
	config = _.defaults(config || {}, {tmp: '/tmp', verbose: false, protocol: 'ftp', path: ''});
	return new DownloadObject([], config)
};

module.exports = {
	DownloadObject: DownloadObject,
	Download: Download,
	FTP: FTP,
	ZIP: ZIP
};




