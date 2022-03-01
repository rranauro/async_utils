var child_process = require('child_process');
module.exports = function(commandStr, args, options, callback) {
	var child = child_process.spawn(commandStr, args)
	, result = '';
	
	parse = typeof (options && options.parse) === 'function' ? options.parse : function(x) {
		
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
	
	child.on('error', function() {
		console.log('child error', arguments);
		callback.apply(null, arguments.slice(0));
	});

	// when command exits
	child.on('exit', function (code) {
		// execute the callback with the results from the workflow
		// callback(code || 0, result);
	});
	
	child.on('close', function (code) {
		// execute the callback with the results from the workflow
		callback(code || 0, result);
	});
	return child;
};
