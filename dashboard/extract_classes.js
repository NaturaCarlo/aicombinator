const fs = require('fs');
const { JSDOM } = require('jsdom');
const dom = new JSDOM(fs.readFileSync('/tmp/yc.html', 'utf8'));
const doc = dom.window.document;

const thesis = doc.querySelector('section.py-20');
if (thesis) {
  console.log("Thesis HTML:");
  console.log(thesis.outerHTML.substring(0, 500));
}

const nav = doc.querySelector('nav.min-\\[1024px\\]\\:flex');
if (nav) {
  console.log("\nNav Desktop HTML:");
  console.log(nav.outerHTML.substring(0, 1000));
}

