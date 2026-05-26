const fs = require('fs');
const { JSDOM } = require('jsdom');
const dom = new JSDOM(fs.readFileSync('/tmp/yc.html', 'utf8'));
const doc = dom.window.document;

const thesis = doc.querySelector('section.py-20');
if (thesis) {
  console.log("Thesis First Letter Classes:");
  console.log(thesis.querySelector('p').className);
}

const room = Array.from(doc.querySelectorAll('section')).find(s => s.textContent.includes('Be in the room with'));
if (room) {
  console.log("\nBe in the room with:");
  console.log(room.outerHTML.substring(0, 500));
}

const news = Array.from(doc.querySelectorAll('section')).find(s => s.textContent.includes('Knowledge & News'));
if (news) {
  console.log("\nNews:");
  console.log(news.outerHTML.substring(0, 500));
}
