var assert = require('assert');
var util = require('../index');
var _ = require('toolbelt');

describe('request', function() {
	it('request google as string', function(done) {
		util.request('https://www.google.com').get(function(err, response) {
			assert.equal(typeof response, 'string');
			_.wait(1, done);
		});
	});
	
	it('request google parseXML', function(done) {
		util.request('https://www.google.com').get({parseXML:true}, function(err, response) {
			assert.equal(typeof response.html, 'object');
			_.wait(1, done);
		});
	});	
});

describe('command', function() {
	it('command "pwd"', function() {
		util.command('pwd', [], null, function(code, response) {
			assert.equal(_.trim(response), process.env.PWD);
		});
	});
	
	it('command "ls -l"', function() {
		util.command('ls', ['-l'], {pipe:false}, function(code, response) {
			assert.equal(response.indexOf('total') === code, true);
		});
	});
});

describe('FTP', function() {
	var FTP = util.FTP({
		tmp: '/tmp',
		host: 'ftp.ncbi.nlm.nih.gov',
		password: 'ron@inciteadvisors.com',
		path: 'pubmed/baseline',
		limit: 2,
		verbose: true
	});
	
	it('contents', function(done) {
		this.timeout(0);
		FTP.contents(function(err, response) {
			assert.equal(response.files().length, 2);
			done();
		});
	});
	
	it('get', function(done) {
		this.timeout(0);
		FTP.each(FTP.get, function(err, response) {
			assert.equal(FTP.downloaded.length, 2);
			done();
		}, FTP);
	});
	
	it('gunzip', function(done) {
		this.timeout(0);
		FTP.unzipAll(null, function(err) {
			assert.equal(err, null);
			done();			
		});
	});
	
	var handler = function() {
		var count = 0;
		
		return {
			line: function(line) {
				count += line.indexOf('PubmedArticle') !== -1 ? 1 : 0; 
			},
			count: function() {
				return count;
			}
		}
	};
	
	it('readByLine', function(done) {
		
		this.timeout(0);
		FTP.files()[0].readByLine(handler(), function(err, item, obj) {
			assert.equal(!!obj.count(), true);
			done();
		});
	});
	
	it('cleanup', function(done) {
		FTP.cleanup(function(err, response) {
			assert.equal(err, null);
			done();			
		});
	});
});

describe('ZIP', function() {
	var old_link = 'downloads/Drugs/InformationOnDrugs/UCM135169.zip'

	var Stream = util.ZIP({hostname: 'https://www.fda.gov', fname: 'BMIS.zip', path: 'media/128517/download'});
	
	it('download', function(done) {
		this.timeout(0);
		Stream.get(function(err, Stream) {
			assert.equal(!!err, false);
			done();
		});
	});
	
	it('contents', function(done) {
		this.timeout(0);
		Stream.contents(function(err, stream, files) {
			assert.equal(!!err, false);
			done();
		});
	});
	
	it('unzip', function(done) {
		this.timeout(0);
		Stream.unzipAll(null, function(err) {
			assert.equal(err, null);
			done();			
		});
	});
	
	it('confirm', function(done) {		
		util.command('ls', [(Stream.files()[0] || {}).path], {pipe:true}, function(err, response) {
			assert.equal( _.trim(response), (Stream.files()[0] || {}).path);
			done();
		});
	});
	
	it('cleanup', function(done) {
		Stream.cleanup(function(err, response) {
			assert.equal(err, null);
			done();			
		});
	});
});


