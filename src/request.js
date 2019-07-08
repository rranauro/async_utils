var _ = require('underscore')._;
_.mixin( require('toolbelt') );
var node_request = require('request');
var ObjTree = require('objtree');

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
module.exports = request;
