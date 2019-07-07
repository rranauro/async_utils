# async_utils
A library of wrapper objects to simplify downloading and streaming content from the web for processing. In particular we make extensive use of the [Async]() library as the workhorse for our asynchronous workflows, and [request]() for streaming data both downloading from remote sources and locally on our machine during processing. 

A data source can be an FTP site or a .ZIP file located at a particular web address. One of the big challenges with data harvesting is processing large data sets while avoiding *out of memory* issues on the client. Similarly, data servers often limit the number of requests per second a client can make. Thus we need to respect these limitations and write workflows that are durable and can be restarted in case of failure during processing.

## Overview
The library exports 5 methods: _request_, _command_, _FTP_, _ZIP_, and _Download_. 

_request_: Wrapper for node request, for which there are many [alternatives](https://github.com/request/request/issues/3143). The main advantage of this version is to provide some optional processing of the response before calling back the requestor. For example, a `parseXML` option will parse an `XML` or `HTML` string into JSON. The other objects in this library use this wrapper but its use is otherwise non-essential.

_command_: Wrapper for spawning child processes in Node.

_FTP_: An object that takes a configuration object and sets up a connection to a remote FTP server. Supply a `/tmp` directory locally and a `path` on the remote FTP server, the object creates a manifest of files located in the remote ftp directory and the produces a `Download` object (see below) for each entry in the archive. The `Download` object can stream itself from from the server and unzip itself in place. Asynchronous `each` iterator methods control the level of concurrency we allow when requesting remote server resources and processing on our local machine.

_ZIP_: An object that takes a configuration object and sets up a connection to a remote HTTP server. Supply a `/tmp` directory locally and a `path` on the remote FTP server, the object streams the remote `.zip` locally before reading the manifest of files in the ZIP archive and the produces a `Download` object (see below) for each entry in the archive. The `Download` object can unzip itself in place. Asynchronous `each` iterator methods control the level of concurrency we allow when requesting remote server resources and processing on our local machine.

For both _ZIP_ and _FTP_ the configuration object allows specification of a `concurrency` parameter that defines the number of concurrent jobs to process at any one time.

_Download_: For each entry in a ZIP file or remote FTP archive we create a Download object with methods for downloading, unzipping, and cleaning up. Once data is ready we provides methods for line oriented stream processing or parsing XML concurrently up to a limit of concurrent processing as defined by the `concurrency` parameter.

## Example: Downloading PubMed
