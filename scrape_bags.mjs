const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://bags.fm/hackathon/apps', { waitUntil: 'networkidle', timeout: 30000 });
  
  // Wait for project list to load
  await page.waitForSelector('a[href*="/apps/"]', { timeout: 15000 }).catch(() => {});
  
  // Scroll to bottom to trigger lazy loading
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(500);
  }
  
  // Extract all project data
  const projects = await page.evaluate(() => {
    const items = [];
    // Try to find project cards
    const links = document.querySelectorAll('a[href*="/apps/"]');
    links.forEach(link => {
      const href = link.getAttribute('href');
      if (!href || href === '/apps') return;
      const text = link.textContent.trim().substring(0, 200);
      items.push({ href, text });
    });
    return items;
  });
  
  console.log('Total links found:', projects.length);
  projects.forEach((p, i) => console.log(i+1, p.href, '|', p.text.substring(0, 80)));
  
  // Also get full page text to find vote counts
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log('\n\n=== BODY TEXT (first 8000 chars) ===\n');
  console.log(bodyText.substring(0, 8000));
  
  await browser.close();
})();
