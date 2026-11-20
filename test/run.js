// tiny zero-dependency test runner
"use strict";

var path = require("path");
var fs = require("fs");

var tests = [];
global.test = function(name, fn) {
	tests.push({name: name, fn: fn});
};

var files = fs.readdirSync(__dirname)
	.filter(function(f) { return f.endsWith(".test.js"); })
	.sort();

files.forEach(function(f) {
	require(path.join(__dirname, f));
});

var pass = 0, fail = 0, failures = [];

tests.forEach(function(t) {
	try {
		t.fn();
		pass++;
		console.log("ok   " + t.name);
	}
	catch (e) {
		fail++;
		failures.push({name: t.name, err: e});
		console.log("FAIL " + t.name);
	}
});

console.log("");
console.log(pass + " passed, " + fail + " failed, " + tests.length + " total");

if (failures.length) {
	console.log("");
	failures.forEach(function(f) {
		console.log("--- " + f.name);
		console.log(f.err && f.err.stack ? f.err.stack : f.err);
	});
	process.exit(1);
}
