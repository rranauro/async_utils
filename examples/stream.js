var util = require('./index');
var _ = require('toolbelt');
var async = require('async');


var Stream = util.ZIP({hostname: 'https://www.fda.gov', fname: 'BMIS.zip', path: 'media/128517/download'});

Stream.get(function(err, S) {
	console.log(err, S == Stream);
	Stream.contents(function(err, stream, files) {
		console.log(err);
		Stream.unzipAll(null, function(err) {
			console.log(err);			
		});
	});
});

return ;
var FTP = util.FTP({
	tmp: '/tmp',
	host: 'ftp.ncbi.nlm.nih.gov',
	password: 'ron@inciteadvisors.com',
	path: 'pubmed/baseline',
	limit: 2,
	verbose: true
});

FTP.contents(function(err, response) {
	FTP.each(FTP.get, function(err, response) {
		FTP.unzipAll(function() {
			console.log(err, response);			
		})
	}, FTP);
});