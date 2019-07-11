# async_utils
A library of wrapper objects to simplify downloading and streaming content from the web for processing. In particular we make extensive use of the [Async]() library as the workhorse for our asynchronous workflows, and [request]() for streaming data both downloading from remote sources and locally on our machine during processing. 

A data source can be an FTP site or a .ZIP file located at a particular web address. One of the big challenges with data harvesting is processing large data sets while avoiding *out of memory* issues on the client. Similarly, data servers often limit the number of requests per second a client can make. Thus we need to respect these limitations and write workflows that are durable and can be restarted in case of failure during processing.

## Overview
The library is encapsulates methods for *FTP* and *ZIP* file handling. An _FTP_ and _ZIP_ are wrapper functions with configurations for respective technologies.

_FTP_: An object that takes a configuration object and sets up a connection to a remote FTP server. Supply a `/tmp` directory locally and a `path` on the remote FTP server, the object creates a manifest of files located in the remote ftp directory and the produces a `Download` object (see below) for each entry in the archive. The `Download` object can stream itself from from the server and unzip itself in place. Asynchronous `each` iterator methods control the level of concurrency we allow when requesting remote server resources and processing on our local machine.

_ZIP_: An object that takes a configuration object and sets up a connection to a remote HTTP server. Supply a `/tmp` directory locally and a `path` on the remote FTP server, the object streams the remote `.zip` locally before reading the manifest of files in the ZIP archive and the produces a `Download` object (see below) for each entry in the archive. The `Download` object can unzip itself in place. Asynchronous `each` iterator methods control the level of concurrency we allow when requesting remote server resources and processing on our local machine.

For both _ZIP_ and _FTP_ the configuration object provides iteration methods and allows specification of a `concurrency` parameter that defines the number of concurrent jobs to process at any one time.

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

// async.auto provides control flow.
// async.auto executes functions asynchronously and in parallel, unless the function is wrapped
// in an array. In that case, the string indices refer to dependent functions that must complete
// before the supplied function can execute.
async.auto({
	contents: function(next) {
		
		// navigate to the directory specified by "path" in our configuration.
		// capture the directory listing at that location and create a manifest
		// attached to the FTP object.
		FTP.contents(next);
	},
	
	fetch: ['contents', function(next) {
		
		// Iterate over each entry in the FTP manifest and execute FTP.get
		// on completion, call next() to advance the workflow.
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
			
			// Note: pubMedByLineHandler function is custom for each data source (see below). 
			// The function must return an object with at least one method called `line`
			// that takes a single argument, the next line from the parsed document.
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
And the `pubMedByLineHandler` function:
```
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
```
## API
### FTP(config), ZIP(config)
Instantiate a _FTP_ or _ZIP_ download object. Config parameters:

- verbose: a boolean flag limits the number of progress messages during processing.
- tmp: a string fully specific path on your local machine where to place downloaded files. Note: You must have write permission.
- host: (FTP only) a string path on the remote FTP server.
- password: (FTP only) a string password
- path: (FTP only) a string path from the root of the FTP server where you want download
- hostname: (ZIP only) a string path on the remote HTTP host.
- fname: (ZIP only) a string file name to give the downloaded ZIP file.
- concurrency: integer amount of parallelism to allow when downloading or processing each entry.
- limit: integer max number of downloads to process (helpful for debugging).
```
// Example FTP config object
{
	verbose: true,
	tmp: '/tmp',
	host: 'ftp.ncbi.nlm.nih.gov',
	password: 'ron@inciteadvisors.com',
	path: 'pubmed/baseline',
	concurrency: 2,
	limit: 5
}
```
#### FTP.contents(response)
Opens connection to the remote FTP server and navigates to the configured `path`. Creates a download object for each entry in the directory listed, the *manifest*. On completion executes `response`.

#### ZIP.contents(response)
Reads an already downloaded ZIP file (see ZIP.get) and creates a *manifest* for each entry in the ZIP file.

#### FTP.get(response)
Downloads an entry in the remote FTP archive to the local /tmp directory.

#### ZIP.get(response)
Pipes the ZIP file at the remote location defined by `hostname` into a file named `fname` in the `tmp` directory on the local machine.

#### FTP.each(fN, response [, context]), ZIP.each(fn, response [, context])
Iterates over each entry in the *manifest* and executes the supplied function `fN`. `fN` can be any function that takes two parameters: a `Download` object and a `callback`. Supply an optional `context` parameter to control the value of `this` when calling `fN`.

> Note: FTP.each() will execute concurrently up to the limit specified by the value of `concurrency` configuation parameter.

#### FTP.unzipAll(response), ZIP.unzipAll(response)
Iterates over each entry in the *manifest* and uncompresses the file in the /tmp directory replacing the .gz file with the uncompressed representation of the file. 

> Note: FTP.unzip() will execute concurrently up to the limit specified by the value of `concurrency` configuation parameter.

#### FTP.cleanup(response), ZIP.cleanup(response)
Iterates over each entry in the *manifest* and removes the file from the /tmp directory.

#### FTP.files(), ZIP.files()
Returns an array of `Download` objects, the *manifest*.

### new Download( obj, parent )
This object is created by ZIP or FTP for each entry in the manifest. `obj` is an object with a name property `.gz` extension for FTP or just the name of the target file for ZIP. `parent` is the parent object ZIP or FTP and its configuration. 

#### download.unzip(callback)
Uses the correct algorithm to decompress the file and issues the `callback` on completion.

#### download.cleanup(callback)
Removes the uncompressed file from the file system.

#### download.readXML([options,] callback)
Parse an unzipped downloaded XML into a JSON formatted object. 

#### download.readByLine(lineHandler, callback)
Parse an unzipped downloaded file and call `lineHandler.line` for each line in the file with the text of the line as the sole argument. The `line` method has the logic to delimit files, add them to queues for later processing, etc. The final `callback` is issued with two arguments: an `error` or `null` as the first argument and the `lineHandler` object as the second argument. 



