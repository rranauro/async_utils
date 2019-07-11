# async_utils
A library of wrapper objects to simplify downloading and streaming content from the web for processing. In particular we make extensive use of the [Async]() library as the workhorse for our asynchronous workflows, and [request]() for streaming data both downloading from remote sources and locally on our machine during processing. 

A data source can be an FTP site or a .ZIP file located at a particular web address. One of the big challenges with data harvesting is processing large data sets while avoiding *out of memory* issues on the client. Similarly, data servers often limit the number of requests per second a client can make. Thus we need to respect these limitations and write workflows that are durable and can be restarted in case of failure during processing.

## Overview
The centerpiece of the library is _DownloadsObject_ which encapsulates methods for *FTP* and *ZIP* file handling. An _FTP_ and _ZIP_ are wrapper functions with configurations for respective technologies.

_FTP_: An object that takes a configuration object and sets up a connection to a remote FTP server. Supply a `/tmp` directory locally and a `path` on the remote FTP server, the object creates a manifest of files located in the remote ftp directory and the produces a `Download` object (see below) for each entry in the archive. The `Download` object can stream itself from from the server and unzip itself in place. Asynchronous `each` iterator methods control the level of concurrency we allow when requesting remote server resources and processing on our local machine.

_ZIP_: An object that takes a configuration object and sets up a connection to a remote HTTP server. Supply a `/tmp` directory locally and a `path` on the remote FTP server, the object streams the remote `.zip` locally before reading the manifest of files in the ZIP archive and the produces a `Download` object (see below) for each entry in the archive. The `Download` object can unzip itself in place. Asynchronous `each` iterator methods control the level of concurrency we allow when requesting remote server resources and processing on our local machine.

For both _ZIP_ and _FTP_ the configuration object allows specification of a `concurrency` parameter that defines the number of concurrent jobs to process at any one time.

_Download_: _DownloadObject_ maintains and array of _Download_ objects, one for each entry in a ZIP file or remote FTP archive.  The _Download_ object has methods for downloading, unzipping, and cleaning up. Once data is ready _Download_ provides methods for line oriented stream processing or parsing XML concurrently up to a limit of concurrent processing as defined by the `concurrency` parameter.

Additional methods are exported to support the higher level objects in *async_utils*:

_request_: Wrapper for node request, for which there are many [alternatives](https://github.com/request/request/issues/3143). The main advantage of this version is to provide some optional processing of the response before calling back the requestor. For example, a `parseXML` option will parse an `XML` or `HTML` string into JSON. The other objects in this library use this wrapper but its use is otherwise non-essential.

_command_: Wrapper for spawning child processes in Node.

## Example: Downloading PubMed
The [PubMed](https://www.ncbi.nlm.nih.gov/pubmed/) archive is one of the principal data sources in life science. The [public APIs](https://www.ncbi.nlm.nih.gov/home/develop/api/) are robust, but impose some limits for concurrent access and of course high data volumes can impose latencies that limit high throughput processing. For this reason we want download PubMed and store it locally where we can index it and perform rapid text mining on it.

### Data organization
The [FTP](ftp://ftp.ncbi.nlm.nih.gov/pubmed/) archive at the National Library of Medicine contains two subdirectories where PubMed is stored:
- baseline, back-files of literature going back in time
- updatefiles, recent additions to the literature since the last entry in the baseline.

At the present, _baseline_ comprises 972 gzipped XML files. Each of these incorporates roughly 30,000 discrete XML abstract documents. The compressed files range from 20mb to 30mb in size, uncompressed file sizes are 200mb to 250mb. So, we are looking at roughly 20Gb of download data and 200Gb of data to process. Downloading and unzipping this volume of data is one problem, the bigger problem however is parsing 250Mb uncompressed XML files. Even large clients can choke and run out of memory parsing this volume. Fortunately, Node.js gives us [stream](https://nodejs.org/api/stream.html) processing to handle these cases. *async_utils* neatly encapsulates downloaded and unzipped XML with a streaming API so we can handle 30K files line by line without blowing up memory on our client.

Lets see how we can download PubMed in less than 100 lines of code using *async_utils* and Node.js.


```
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

```

