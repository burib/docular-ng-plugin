var nodeExtend = require('node.extend');
var Q = require('q');
var util = require('util');
var htmlparser = require("htmlparser2");
var DocModel = require('./docModel');


var Parser = function () {};

Parser.prototype = nodeExtend(Parser.prototype, {
    
    parseMarkdown: function (example) {
        var pieces = [], currentExample, currentFile, currentText = null;
        var parser = new htmlparser.Parser({
            onopentag: function (name, attrs) {
                if(name === 'example' || name === 'doc:example') {
                    currentExample = {
                        module: attrs.module,
                        deps: attrs.deps,
                        files: []
                    };
                } else if(name === 'file') {
                    currentFile = {
                        name: attrs.name,
                        content: '',
                        src: attrs.src
                    };
                } else {
                    var attrKV = [];
                    for(var attrKey in attrs) {
                        attrKV.push('' + attrKey + '="' + attrs[attrKey] + '"');
                    }
                    var attrString = attrKV.join(" ");
                    currentText += "<" + name + (attrString ? " " + attrString : '') + ">";
                }
            },
            
            ontext: function (text) {
                if(currentText === null) {
                    currentText = text;
                } else {
                    currentText += text;
                }
            },
            
            onclosetag: function (name) {
                if(name === 'example' || name === 'doc:example') {
                    if(currentText) {
                        pieces.push(currentText);
                        currentText = null;
                    }
                    pieces.push(currentExample);
                    currentExample = null;
                } else if(name === 'file') {
                    currentFile.content = currentText;
                    currentText = null;
                    if(!currentExample) {
                        currentExample = {files: []};
                    }
                    currentExample.files.push(currentFile);
                } else {
                    currentText += "</" + name + ">";
                }
            }
        });
        parser.write(example);
        parser.end();
        if(currentText !== null) {
            pieces.push(currentText);
        }
        return pieces;
    },
    
    parseParam: function (param) {
        var paramData = {
            type: [],
            varName: null,
            altName: null,
            description: null,
            optional: false,
            defaultValue: null
        };
        
        var chunks = param.match(/({([^\}]+)})?\s*([\[\]\=\w\|]+)\s+([\s\S]+)/);
        
        paramData.type = chunks[2] ? chunks[2].split('|').map(function (type) {
            if(type.indexOf('=') !== -1) { paramData.optional = true; }
            type = type.replace(/=.*/, '');
            return {
                name: type,
                type: (type.indexOf('function') !== -1 ? 'function' : type).toLowerCase()
            };
        }) : 'undefined';
        
        paramData.varName = chunks[3].replace('[', '').replace(']', '');
        if(paramData.varName.indexOf('|') !== -1) {
            var names = paramData.varName.split('|');
            paramData.varName = names[0];
            paramData.altName = names[1];
        }
        var defaultValue = paramData.varName.match(/=(.*)/);
        if(defaultValue) {
            defaultValue = defaultValue[1];
            paramData.varName = paramData.varName.replace('=' + defaultValue, '');
        }
        
        paramData.defaultValue = defaultValue;
        paramData.description = chunks[4];
        
        return paramData;
    },
    
    parseDocumentationChunk: function (docChunk, isngdoc, defaultModule) {
        var docItems, docItem, ngdocParamFound = false, docGroup = {
            params: [],
            docType: 'ngdoc'
        }, i, l, docItemContent, docItemKey;
        
        if(!isngdoc) {
            docItems = docChunk.match(/\*\s*@(?:(?!\s*\*\s*@)[\s\S])+/gm);
        } else {
            docItems = docChunk.match(/^@[^\n\r]+/gm);
        }
        if(!docItems) {
            return false;
        }
        for(i = 0, l = docItems.length; i < l; i++) {
            docItems[i] = docItems[i].replace(/[\t ]*\*[\t ]*/g, '');
            if(docItems[i].indexOf('@ngdoc') !== -1) {
                ngdocParamFound = true;
            }
        }
        
        //Exit if not angular doc - helps prevent errors
        if(!ngdocParamFound) { return false; }
        var parentDoc, parentName;
        for(var i = 0, l = docItems.length; i < l; i++) {
            docItem = docItems[i];
            if(isngdoc) {
                docItem = docItem.replace('@description', '@description ');
            }
            var matches = docItem.match(/@([\w\d]+)\s*([\s\S]+)?/);
            
            if(!matches) {
                return false;
            }
            
            docItemKey = matches[1];
            docItemContent = matches[2] || '';
            docItemContent = docItemContent.replace(/[\n\r\s]+$/, '')
            if(docItemKey === 'description' && isngdoc) {
                docItemContent = docChunk.match(/@description([\s\S]+)/);
                docItemContent = docItemContent[1];
            }
            
            switch(docItemKey) {
                case 'param': 
                    docGroup.params.push(this.parseParam(docItemContent));
                break;
                case 'description':
                case 'example':
                    docGroup[docItemKey] = this.parseMarkdown(docItemContent);
                break;
                case 'scope':
                    console.log("Found scope")
                    docGroup.scope = true;
                break;
                case 'methodOf':
                case 'propertyOf':
                case 'eventOf':
                case 'memberOf': //Non standard, but needed for organization
                    docGroup[docItemKey] = docItemContent;
                    parentDoc = docItemContent;
                break;
                case "name":
                    if(docGroup.ngdoc === 'method' || docGroup.ngdoc === 'property' || docGroup.ngdoc === 'event' || docGroup.ngdoc === 'function' || docGroup.ngdoc == 'type' || docGroup.ngdoc === 'overview') {
                        if(docItemContent.indexOf('#') !== -1 || docItemContent.indexOf(':') !== -1) {
                            var split = docItemContent.split(/[#:]/);
                            parentDoc = split[0];
                            docItemContent = split[1];
                        } else if(!parentDoc && defaultModule) {
                            parentDoc = defaultModule;
                        }
                    } else if(defaultModule && !parentDoc) {
                        parentDoc = defaultModule;
                    }
                /*falls through*/
                default: 
                    docGroup[docItemKey] = docItemContent;
                    break;
            }
        }
        
        if(docGroup.ngdoc != 'module') {
            docGroup.parentDoc = {
                module: docGroup.module,
                name: parentDoc
            };
            if(parentDoc) {
                docGroup.parentDoc.name = parentDoc;
            }
        }
        
        return docGroup;
    },
    
    parse: function (fileData, allFiles) {
        
        var content = fileData.content, documentationChunks, isngdoc = false;
        if(fileData.extension === 'ngdoc') {
            documentationChunks = [content];
            isngdoc = true;
        } else {
            documentationChunks = content.match(/\/\*{2,}(?:(?!\*{1,}\/)[\s\S])+/gm);
        }
        
        if(!documentationChunks) {
            return false;
        }
        
        var results = [], defaultModule = null;
        for(var i = 0, l = documentationChunks.length; i < l; i++) {
            var result = this.parseDocumentationChunk(documentationChunks[i], isngdoc, defaultModule);
            if(result) {
                result.file = fileData.fileName;
                results.push(result); 
            }
        }
        return results;
    },
    
    backfill: function (fileData, allFiles) {
        for(var i = 0, l = fileData.docs.length; i < l; i++) {
            var doc = fileData.docs[i];
            
            if(doc.ngdoc !== undefined && !doc.module) {
                doc.module = this.guessModuleFromFiles(doc, allFiles);
                if(doc.parentDoc && !doc.parentDoc.module) {
                    doc.parentDoc.module = doc.module;
                }
            }
        }
    },
    
    guessModuleFromFiles: function (docModel, allFiles) {
        var currentFile = docModel.file;
        var fileMatcher = '[^\\/\\\\]+$';
        var currentFolder = currentFile.replace(new RegExp(fileMatcher), '');
        
        var module = this._findModuleDeclaration(currentFolder, allFiles);
        return module;
    },
    
    _findModuleDeclaration: function (inFolder, allFiles) {
        var fileMatcher = '[^\\/\\\\]+$';
        var regex = new RegExp('^' + inFolder + fileMatcher);
        for(var fileName in allFiles) {
            if(fileName.match(regex)){
                var docs = allFiles[fileName].docs;
                for(var i = 0, l = docs.length; i < l; i++) {
                    if(docs[i].ngdoc === 'module') {
                        return docs[i].name;
                    }
                }
            }
        }
        var folders = inFolder.split('/');
        if(inFolder.match(/\//g) && inFolder.match(/\//g).length > 1) {
            var popped = folders.pop();
            if(!popped) {
                folders.pop();
            }
            return this._findModuleDeclaration(folders.join('/') + '/', allFiles);
        } else {
            return;
        }
    }
});

module.exports = Parser;