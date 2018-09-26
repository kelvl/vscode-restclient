"use strict";

import * as fs from 'fs-extra';
import { EOL } from 'os';
import * as path from 'path';
import { Stream } from 'stream';
import { Uri, window } from 'vscode';
import { ArrayUtility } from '../common/arrayUtility';
import { Headers } from '../models/base';
import { RestClientSettings } from '../models/configurationSettings';
import { FormParamEncodingStrategy } from '../models/formParamEncodingStrategy';
import { HttpRequest } from '../models/httpRequest';
import { IRequestParser } from '../models/IRequestParser';
import { MimeUtility } from './mimeUtility';
import { getHeader } from './misc';
import { RequestParserUtil } from './requestParserUtil';
import { getWorkspaceRootPath } from './workspaceUtility';

const CombinedStream = require('combined-stream');
const encodeurl = require('encodeurl');

export class HttpRequestParser implements IRequestParser {
    private readonly _restClientSettings: RestClientSettings = RestClientSettings.Instance;
    private static readonly defaultMethod = 'GET';
    private static readonly uploadFromFileSyntax = /^<\s+([\S]*)\s*$/;

    public parseHttpRequest(requestRawText: string, requestAbsoluteFilePath: string): HttpRequest {
        // parse follows http://www.w3.org/Protocols/rfc2616/rfc2616-sec5.html
        // split the request raw text into lines
        let lines: string[] = requestRawText.split(EOL);

        // skip leading empty lines
        lines = ArrayUtility.skipWhile(lines, value => value.trim() === '');

        // skip trailing empty lines
        lines = ArrayUtility.skipWhile(lines.reverse(), value => value.trim() === '').reverse();

        if (lines.length === 0) {
            return null;
        }

        // parse request line
        let requestLine = HttpRequestParser.parseRequestLine(lines[0]);

        // get headers range
        let headers: Headers;
        let body: string | Stream;
        let bodyLines: string[] = [];
        let headerStartLine = ArrayUtility.firstIndexOf(lines, value => value.trim() !== '', 1);
        if (headerStartLine !== -1) {
            if (headerStartLine === 1) {
                // parse request headers
                let firstEmptyLine = ArrayUtility.firstIndexOf(lines, value => value.trim() === '', headerStartLine);
                let headerEndLine = firstEmptyLine === -1 ? lines.length : firstEmptyLine;
                let headerLines = lines.slice(headerStartLine, headerEndLine);
                let index = 0;
                let queryString = '';
                for (; index < headerLines.length; ) {
                    let headerLine = (headerLines[index]).trim();
                    if (['?', '&'].includes(headerLine[0])) {
                        queryString += headerLine;
                        index++;
                        continue;
                    }
                    break;
                }

                if (queryString !== '') {
                    requestLine.url += queryString;
                }
                headers = RequestParserUtil.parseRequestHeaders(headerLines.slice(index));

                // get body range
                let bodyStartLine = ArrayUtility.firstIndexOf(lines, value => value.trim() !== '', headerEndLine);
                if (bodyStartLine !== -1) {
                    let contentTypeHeader = getHeader(headers, 'content-type') || getHeader(this._restClientSettings.defaultHeaders, 'content-type');
                    firstEmptyLine = ArrayUtility.firstIndexOf(lines, value => value.trim() === '', bodyStartLine);
                    let bodyEndLine = MimeUtility.isMultiPartFormData(contentTypeHeader) || firstEmptyLine === -1 ? lines.length : firstEmptyLine;
                    bodyLines = lines.slice(bodyStartLine, bodyEndLine);
                }
            } else {
                // parse body, since no headers provided
                let firstEmptyLine = ArrayUtility.firstIndexOf(lines, value => value.trim() === '', headerStartLine);
                let bodyEndLine = firstEmptyLine === -1 ? lines.length : firstEmptyLine;
                bodyLines = lines.slice(headerStartLine, bodyEndLine);
            }
        }

        // if Host header provided and url is relative path, change to absolute url
        let host = getHeader(headers, 'Host') || getHeader(this._restClientSettings.defaultHeaders, 'host');
        if (host && requestLine.url[0] === '/') {
            let [, port] = host.split(':');
            let scheme = port === '443' || port === '8443' ? 'https' : 'http';
            requestLine.url = `${scheme}://${host}${requestLine.url}`;
        }

        // parse body
        let contentTypeHeader = getHeader(headers, 'content-type') || getHeader(this._restClientSettings.defaultHeaders, 'content-type');
        body = HttpRequestParser.parseRequestBody(bodyLines, requestAbsoluteFilePath, contentTypeHeader);
        if (this._restClientSettings.formParamEncodingStrategy !== FormParamEncodingStrategy.Never && body && typeof body === 'string' && MimeUtility.isFormUrlEncoded(contentTypeHeader)) {
            if (this._restClientSettings.formParamEncodingStrategy === FormParamEncodingStrategy.Always) {
                const stringPairs = body.split('&');
                const encodedStringParis = [];
                for (const stringPair of stringPairs) {
                    const [name, ...values] = stringPair.split('=');
                    let value = values.join('=');
                    encodedStringParis.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
                }
                body = encodedStringParis.join('&');
            } else {
                body = encodeurl(body);
            }
        }

        if (typeof body === 'string') {
            body = HttpRequestParser.maybeTransformJSONToURLEncodedForm(contentTypeHeader, bodyLines.join(EOL));
            headers = HttpRequestParser.fixContentType(headers);
        }

        return new HttpRequest(requestLine.method, requestLine.url, headers, body, bodyLines.join(EOL));
    }

    private static fixContentType(headers: { [key: string]: string }) {
        const contentType = getHeader(headers, 'content-type');
        if (contentType === 'application/x-www-form-urlencoded+json') {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            return headers;
        } else {
            return headers;
        }
    }

    private static flattenJSON(keys: Array<string>, hash: Object): Array<[Array<String>, string]> {
        let results = [];
        Object.keys(hash).map((k) => {
            if (typeof hash[k] === "object") {
                results = results.concat(HttpRequestParser.flattenJSON(keys.concat([k]), hash[k]));
            } else {
                results.push([keys.concat([k]), hash[k]]);
            }
        });

        return results;
    }

    private static flattenJSONKeys(keys: Array<string>, value: any) {
        if (typeof value === "object" && !(value instanceof Array)) {
            return Object.keys(value).reduce((acc, k) => {
                const inner = this.flattenJSONKeys(keys.concat(k), value[k]);
                return acc.concat(inner);
            }, []);
        } else if (value instanceof Array) {
            return value.reduce((acc, x) => {
                return acc.concat(this.flattenJSONKeys(keys.concat(""), x));
            }, []);
        } else {
            return [[keys, value]];
        }
    }

    private static convertKeys(values: Array<[string[], any]>) {
        return values.map((x) => {
            const keys = x[0];
            const first = keys.slice(0, 1);
            const remaining = keys.slice(1).map((x) => `[${x}]`);
            const k = encodeURIComponent(first.concat(remaining).join(''));
            const value = encodeURIComponent(x[1]);
            return `${k}=${value}`;
        }).join("&");
    }

    private static maybeTransformJSONToURLEncodedForm(contentTypeHeader: string, bodyJoined: string): string {
        if (contentTypeHeader === 'application/x-www-form-urlencoded+json') {
            try {
                let formObject = JSON.parse(bodyJoined);
                return this.convertKeys(this.flattenJSONKeys([], formObject));
            } catch (ex) {
                window.showErrorMessage(`Unable to parse JSON: ${ex}`);
                throw ex;
                // return bodyJoined;
            }
        } else {
            return bodyJoined;
        }
    }

    private static parseRequestLine(line: string): { method: string, url: string } {
        // Request-Line = Method SP Request-URI SP HTTP-Version CRLF
        let words = line.split(' ').filter(Boolean);

        let method: string;
        let url: string;
        if (words.length === 1) {
            // Only provides request url
            method = HttpRequestParser.defaultMethod;
            url = words[0];
        } else {
            // Provides both request method and url
            method = words.shift();
            url = line.trim().substring(method.length).trim();
            let match = words[words.length - 1].match(/HTTP\/.*/gi);
            if (match) {
                url = url.substring(0, url.lastIndexOf(words[words.length - 1])).trim();
            }
        }

        return {
            method: method,
            url: url
        };
    }

    private static parseRequestBody(lines: string[], requestFileAbsolutePath: string, contentTypeHeader: string): string | Stream {
        if (!lines || lines.length === 0) {
            return null;
        }

        // Check if needed to upload file
        if (lines.every(line => !HttpRequestParser.uploadFromFileSyntax.test(line))) {
            if (!MimeUtility.isFormUrlEncoded(contentTypeHeader)) {
                return lines.join(EOL);
            } else {
                return lines.reduce((p, c, i) => {
                    p += `${(i === 0 || c.startsWith('&') ? '' : EOL)}${c}`;
                    return p;
                }, '');
            }
        } else {
            let combinedStream = CombinedStream.create({ maxDataSize: 10 * 1024 * 1024 });
            for (const [index, line] of lines.entries()) {
                if (HttpRequestParser.uploadFromFileSyntax.test(line)) {
                    let groups = HttpRequestParser.uploadFromFileSyntax.exec(line);
                    if (groups !== null && groups.length === 2) {
                        let fileUploadPath = groups[1];
                        let fileAbsolutePath = HttpRequestParser.resolveFilePath(fileUploadPath, requestFileAbsolutePath);
                        if (fileAbsolutePath && fs.existsSync(fileAbsolutePath)) {
                            combinedStream.append(fs.createReadStream(fileAbsolutePath));
                        } else {
                            combinedStream.append(line);
                        }
                    }
                } else {
                    combinedStream.append(line);
                }

                if (index !== lines.length - 1) {
                    combinedStream.append(HttpRequestParser.getLineEnding(contentTypeHeader));
                }
            }

            return combinedStream;
        }
    }

    private static getLineEnding(contentTypeHeader: string) {
        return MimeUtility.isMultiPartFormData(contentTypeHeader) ? '\r\n' : EOL;
    }

    private static resolveFilePath(refPath: string, httpFilePath: string): string {
        if (path.isAbsolute(refPath)) {
            return fs.existsSync(refPath) ? refPath : null;
        }

        let absolutePath;
        let rootPath = getWorkspaceRootPath();
        if (rootPath) {
            absolutePath = path.join(Uri.parse(rootPath).fsPath, refPath);
            if (fs.existsSync(absolutePath)) {
                return absolutePath;
            }
        }

        absolutePath = path.join(path.dirname(httpFilePath), refPath);
        if (fs.existsSync(absolutePath)) {
            return absolutePath;
        }

        return null;
    }
}
