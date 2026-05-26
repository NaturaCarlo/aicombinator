const fs = require('fs');
const { JSDOM } = require('jsdom');
const dom = new JSDOM(fs.readFileSync('/tmp/yc.html', 'utf8'));
const doc = dom.window.document;

// Remove SVGs and Scripts to clean up HTML
doc.querySelectorAll('svg').forEach(el => el.replaceWith('[SVG]'));
doc.querySelectorAll('script').forEach(el => el.remove());

console.log("HEADER:");
console.log(doc.querySelector('header').outerHTML);

console.log("\nHERO:");
// Hero seems to be the first div in main or something similar
const hero = doc.querySelector('#hero') || doc.querySelector('main > div') || doc.querySelector('div.relative.z-\\[2\\]');
if (hero) {
  console.log(hero.outerHTML);
}
