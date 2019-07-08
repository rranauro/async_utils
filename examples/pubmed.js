var util = require('../index');
var _ = require('toolbelt');
var async = require('async');
var ObjTree = require('objtree');

// create the FTP object
var FTP = util.FTP({
	verbose: true,
	tmp: '/tmp',
	host: 'ftp.ncbi.nlm.nih.gov',
	password: 'ron@inciteadvisors.com',
	path: 'pubmed/baseline',
	concurrency: 2,
	limit: 5
});

var pubMedByLineHandler = function() {
	var bigString = [];
	var articles = [];
    var toJson = new ObjTree();
   	toJson.force_array = ["MeshHeading", "DataBank", "AccessionNumber", "QualifierName", "AffiliationInfo"];	
	
	return {
		line: function( line ) {  
			line = line.trim();
	
			if (line.indexOf('<PubmedArticle>') !== -1) {
				bigString.push( line );
			} else if (line.indexOf('</PubmedArticle>') !== -1) {
				bigString.push( line );
				articles.push( toJson.parseXML( bigString.join(''), { errorHandler: function( errorStr ) {
			
					// skip warnings;
					if (errorStr.indexOf('warning') !== -1) return ;
					console.log(errorStr);
					return ;

				} }) );
				bigString.length = 0;
			} else if (!!bigString.length) {
				bigString.push( line );
			}
		},
		toJSON: function() {
			return articles;
		}
	}
};

// async.auto provides control flow.
async.auto({
	contents: function(next) {
		
		// navigate to the directory specified by "path" in our configuration.
		// capture the directory listing at that location and create a manifest
		// attached to the FTP object.
		FTP.contents(next);
	},
	
	fetch: ['contents', function(next) {
		
		FTP.each(FTP.get, next, FTP);
	}],
	
	unzip: ['fetch', function(next) {
		
		// FTP unzips each file in the manifest and calls a function
		// to process the unzipped file. The context of the function 
		// is the Download object 
		FTP.unzipAll(function(callback) {
			
			// we can use "readByLine" to process the very large XML document
			// produced by each unzipped file. The NLM package 30,000 discrete PubMed
			// abstract documents in each download. If we try to parse XML in one shot
			// we will run out of memory
			this.readByLine(pubMedByLineHandler(), function(err, item, downloaded) {
				
				// downloaded is the object produced by byLineHandler.
				// toJSON() has our array of articles downloaded and parsed from Pubmed
				console.log('[download] info:', item.fname, downloaded.toJSON().length);
				callback();
			});
		}, next);
	}],
	
	cleanup: ['unzip', function(next) {
		
		// loop over uncompressed output files and remove.
		FTP.cleanup(function(err) {
			
			// an "ls -l" on the /tmp directory should show no files from our download.
			console.log('[example] info:', err ? err.message : 'Finished.');
			next();
		});
	}]
});
