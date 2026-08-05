const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

(async () => {
  console.log('Launching stealth browser to bypass bot protections...');
  try {
    const launchOptions = { 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    const browser = await puppeteer.launch(launchOptions);
    
    const page = await browser.newPage();
    console.log('Navigating to YouTube to generate human session...');
    
    // Go to youtube and wait for cookies to be set
    await page.goto('https://www.youtube.com', { waitUntil: 'networkidle2' });
    
    // Add a tiny delay to ensure all JS challenges run
    await new Promise(r => setTimeout(r, 2000));
    
    const cookies = await page.cookies();
    
    let netscapeStr = "# Netscape HTTP Cookie File\n# http://curl.haxx.se/rfc/cookie_spec.html\n# This is a generated file!  Do not edit.\n\n";
    
    cookies.forEach(cookie => {
      const domain = cookie.domain;
      const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const path = cookie.path;
      const secure = cookie.secure ? 'TRUE' : 'FALSE';
      const expires = cookie.expires === -1 ? 0 : Math.floor(cookie.expires);
      const name = cookie.name;
      const value = cookie.value;
      
      netscapeStr += `${domain}\t${includeSubdomains}\t${path}\t${secure}\t${expires}\t${name}\t${value}\n`;
    });
    
    fs.writeFileSync('cookies.txt', netscapeStr);
    console.log('Successfully generated cookies.txt in Netscape format!');
    
    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error('Failed to generate cookies:', err);
    process.exit(1);
  }
})();
