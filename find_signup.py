import asyncio
from playwright.async_api import async_playwright


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        page = await browser.new_page()
        await page.goto("https://www.webshare.io/", wait_until="networkidle")
        await page.wait_for_timeout(3000)
        links = await page.evaluate("""() => {
            return Array.from(document.querySelectorAll('a')).map(a => ({
                text: a.innerText.trim(),
                href: a.href
            })).filter(a => a.text.length > 0 && a.text.length < 50)
        }""")
        for l in links:
            print(f"{l['text']}: {l['href']}")
        await page.screenshot(path="webshare_home.png")
        await browser.close()


asyncio.run(main())
