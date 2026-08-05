const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

let activeBrowser = null;
let syncInterval = null;

async function launchStealthBrowser() {
  if (activeBrowser) {
    // Bring to front or just return if already running
    const pages = await activeBrowser.pages();
    if (pages.length > 0) {
      await pages[0].bringToFront();
    }
    return { success: true, message: 'Browser is already running' };
  }

  try {
    const userDataDir = path.join(__dirname, 'stealth_profile');
    
    activeBrowser = await puppeteer.launch({
      headless: false,
      userDataDir: userDataDir,
      defaultViewport: null,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--start-maximized'
      ]
    });

    const pages = await activeBrowser.pages();
    const page = pages[0];
    // Create a small local start page or just go to google
    const startHtml = `
      <html>
        <body style="font-family: sans-serif; text-align: center; margin-top: 50px; background: #0f172a; color: white;">
          <h1>DownMaster Stealth Browser</h1>
          <p>You can browse any website here (Facebook, Instagram, YouTube, etc.)</p>
          <p>Log in to your accounts to access private videos.</p>
          <p>Your session is securely synced to DownMaster automatically!</p>
          <div style="margin-top: 30px;">
            <a href="https://www.youtube.com" style="color: #60a5fa; margin: 10px;">YouTube</a>
            <a href="https://www.instagram.com" style="color: #60a5fa; margin: 10px;">Instagram</a>
            <a href="https://www.facebook.com" style="color: #60a5fa; margin: 10px;">Facebook</a>
            <a href="https://www.tiktok.com" style="color: #60a5fa; margin: 10px;">TikTok</a>
            <a href="https://www.twitter.com" style="color: #60a5fa; margin: 10px;">Twitter/X</a>
          </div>
        </body>
      </html>
    `;
    await page.setContent(startHtml);

    // Start cookie sync interval
    syncInterval = setInterval(async () => {
      try {
        if (!activeBrowser) return;
        const allPages = await activeBrowser.pages();
        if (allPages.length === 0) return;
        
        // Get cookies from all open pages
        let allCookies = [];
        for (const p of allPages) {
          try {
            const cookies = await p.cookies();
            allCookies = allCookies.concat(cookies);
          } catch(e) {} // ignore if page closed during check
        }
        
        // Deduplicate cookies
        const uniqueCookies = [];
        const seen = new Set();
        for (const c of allCookies) {
          const key = `${c.domain}_${c.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            uniqueCookies.push(c);
          }
        }

        let netscapeStr = "# Netscape HTTP Cookie File\n# http://curl.haxx.se/rfc/cookie_spec.html\n# This is a generated file!  Do not edit.\n\n";
        
        uniqueCookies.forEach(cookie => {
          const domain = cookie.domain;
          const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
          const cookiePath = cookie.path;
          const secure = cookie.secure ? 'TRUE' : 'FALSE';
          const expires = cookie.expires === -1 ? 0 : Math.floor(cookie.expires);
          const name = cookie.name;
          const value = cookie.value;
          
          netscapeStr += `${domain}\t${includeSubdomains}\t${cookiePath}\t${secure}\t${expires}\t${name}\t${value}\n`;
        });
        
        fs.writeFileSync(path.join(__dirname, 'cookies.txt'), netscapeStr);
      } catch (err) {
        console.error('Error syncing cookies:', err);
      }
    }, 3000); // Sync every 3 seconds

    activeBrowser.on('disconnected', () => {
      console.log('Stealth browser closed by user');
      clearInterval(syncInterval);
      activeBrowser = null;
    });

    return { success: true };
  } catch (err) {
    console.error('Failed to launch stealth browser:', err);
    return { success: false, error: err.message };
  }
}

module.exports = {
  launchStealthBrowser
};
