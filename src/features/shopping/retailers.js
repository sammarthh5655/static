'use strict';

/**
 * The shops "Compare prices" asks about, by country and by kind of product.
 *
 * Every link the comparison shows is built HERE, from a shop's own search
 * address and the product's name - never taken from the model. A model asked
 * for a product page will happily write a plausible address that does not
 * exist; a search on the shop's own site always lands somewhere real, and
 * shows the person the live price rather than our estimate of it.
 *
 * `{q}` is the product name, URL-encoded; `{slug}` is the same name as
 * lower-case words joined by dashes, for the few shops that search by path.
 * `hue` tints the shop's monogram so a long list can be scanned by colour.
 */

const REGIONS = {
  in: {
    id: 'in',
    name: 'India',
    currency: 'INR',
    locale: 'en-IN',
    shops: {
      amazon_in: { name: 'Amazon.in', domain: 'amazon.in', hue: 32, search: 'https://www.amazon.in/s?k={q}' },
      flipkart: { name: 'Flipkart', domain: 'flipkart.com', hue: 212, search: 'https://www.flipkart.com/search?q={q}' },
      croma: { name: 'Croma', domain: 'croma.com', hue: 170, search: 'https://www.croma.com/searchB?q={q}%3Arelevance&text={q}' },
      reliance_digital: { name: 'Reliance Digital', domain: 'reliancedigital.in', hue: 0, search: 'https://www.reliancedigital.in/search?q={q}' },
      vijay_sales: { name: 'Vijay Sales', domain: 'vijaysales.com', hue: 350, search: 'https://www.vijaysales.com/search-listing?q={q}' },
      tatacliq: { name: 'Tata CLiQ', domain: 'tatacliq.com', hue: 330, search: 'https://www.tatacliq.com/search/?searchCategory=all&text={q}' },
      jiomart: { name: 'JioMart', domain: 'jiomart.com', hue: 220, search: 'https://www.jiomart.com/search/{q}' },
      snapdeal: { name: 'Snapdeal', domain: 'snapdeal.com', hue: 345, search: 'https://www.snapdeal.com/search?keyword={q}' },
      poorvika: { name: 'Poorvika', domain: 'poorvika.com', hue: 25, search: 'https://www.poorvika.com/s?q={q}' },
      shopclues: { name: 'ShopClues', domain: 'shopclues.com', hue: 195, search: 'https://www.shopclues.com/search?q={q}' },
      meesho: { name: 'Meesho', domain: 'meesho.com', hue: 300, search: 'https://www.meesho.com/search?q={q}' },
      myntra: { name: 'Myntra', domain: 'myntra.com', hue: 340, search: 'https://www.myntra.com/{slug}?rawQuery={q}' },
      ajio: { name: 'AJIO', domain: 'ajio.com', hue: 200, search: 'https://www.ajio.com/search/?text={q}' },
      nykaa_fashion: { name: 'Nykaa Fashion', domain: 'nykaafashion.com', hue: 325, search: 'https://www.nykaafashion.com/catalogsearch/result/?q={q}' },
      lifestyle: { name: 'Lifestyle', domain: 'lifestylestores.com', hue: 15, search: 'https://www.lifestylestores.com/in/en/search?q={q}' },
      shoppers_stop: { name: 'Shoppers Stop', domain: 'shoppersstop.com', hue: 280, search: 'https://www.shoppersstop.com/search?q={q}' },
      nykaa: { name: 'Nykaa', domain: 'nykaa.com', hue: 330, search: 'https://www.nykaa.com/search/result/?q={q}' },
      purplle: { name: 'Purplle', domain: 'purplle.com', hue: 275, search: 'https://www.purplle.com/search?q={q}' },
      tira: { name: 'Tira', domain: 'tirabeauty.com', hue: 355, search: 'https://www.tirabeauty.com/products/?q={q}' },
      tata_1mg: { name: 'Tata 1mg', domain: '1mg.com', hue: 8, search: 'https://www.1mg.com/search/all?name={q}' },
      pepperfry: { name: 'Pepperfry', domain: 'pepperfry.com', hue: 28, search: 'https://www.pepperfry.com/site_product/search?q={q}' },
      ikea_in: { name: 'IKEA', domain: 'ikea.com/in', hue: 52, search: 'https://www.ikea.com/in/en/search/?q={q}' },
      urban_ladder: { name: 'Urban Ladder', domain: 'urbanladder.com', hue: 140, search: 'https://www.urbanladder.com/products/search?keywords={q}' },
      bigbasket: { name: 'BigBasket', domain: 'bigbasket.com', hue: 90, search: 'https://www.bigbasket.com/ps/?q={q}' },
      blinkit: { name: 'Blinkit', domain: 'blinkit.com', hue: 55, search: 'https://blinkit.com/s/?q={q}' },
      zepto: { name: 'Zepto', domain: 'zeptonow.com', hue: 285, search: 'https://www.zeptonow.com/search?query={q}' },
      instamart: { name: 'Swiggy Instamart', domain: 'swiggy.com', hue: 22, search: 'https://www.swiggy.com/instamart/search?query={q}' },
      dmart: { name: 'DMart Ready', domain: 'dmart.in', hue: 120, search: 'https://www.dmart.in/search?searchTerm={q}' },
      bookswagon: { name: 'Bookswagon', domain: 'bookswagon.com', hue: 205, search: 'https://www.bookswagon.com/search-books/{slug}' },
      crossword: { name: 'Crossword', domain: 'crossword.in', hue: 45, search: 'https://www.crossword.in/search?q={q}' },
      sapna: { name: 'Sapna Online', domain: 'sapnaonline.com', hue: 10, search: 'https://www.sapnaonline.com/search?keyword={q}' },
      decathlon_in: { name: 'Decathlon', domain: 'decathlon.in', hue: 210, search: 'https://www.decathlon.in/search?query={q}' },
      firstcry: { name: 'FirstCry', domain: 'firstcry.com', hue: 30, search: 'https://www.firstcry.com/search?q={q}' },
      hamleys_in: { name: 'Hamleys', domain: 'hamleys.in', hue: 0, search: 'https://www.hamleys.in/search?q={q}' },
    },
    categories: {
      electronics: ['amazon_in', 'flipkart', 'croma', 'reliance_digital', 'vijay_sales', 'tatacliq', 'jiomart', 'snapdeal', 'poorvika', 'shopclues'],
      appliances: ['amazon_in', 'flipkart', 'croma', 'reliance_digital', 'vijay_sales', 'tatacliq', 'jiomart', 'snapdeal', 'pepperfry', 'shopclues'],
      fashion: ['myntra', 'ajio', 'amazon_in', 'flipkart', 'tatacliq', 'nykaa_fashion', 'meesho', 'snapdeal', 'lifestyle', 'shoppers_stop'],
      beauty: ['nykaa', 'purplle', 'tira', 'amazon_in', 'flipkart', 'myntra', 'tatacliq', 'jiomart', 'tata_1mg', 'bigbasket'],
      home: ['pepperfry', 'ikea_in', 'urban_ladder', 'amazon_in', 'flipkart', 'tatacliq', 'jiomart', 'snapdeal', 'meesho', 'shopclues'],
      grocery: ['bigbasket', 'blinkit', 'zepto', 'instamart', 'jiomart', 'amazon_in', 'flipkart', 'dmart', 'tata_1mg', 'snapdeal'],
      books: ['amazon_in', 'flipkart', 'bookswagon', 'crossword', 'sapna', 'snapdeal', 'meesho', 'shopclues', 'tatacliq', 'jiomart'],
      sports: ['decathlon_in', 'amazon_in', 'flipkart', 'myntra', 'ajio', 'tatacliq', 'snapdeal', 'meesho', 'jiomart', 'shopclues'],
      kids: ['firstcry', 'hamleys_in', 'amazon_in', 'flipkart', 'myntra', 'ajio', 'tatacliq', 'jiomart', 'snapdeal', 'meesho'],
      general: ['amazon_in', 'flipkart', 'tatacliq', 'jiomart', 'snapdeal', 'meesho', 'croma', 'reliance_digital', 'shopclues', 'myntra'],
    },
    // Brands whose own Indian store has a search we know the shape of. Any
    // other brand's store is searched through Google, limited to its site.
    brands: {
      apple: { name: 'Apple Store', domain: 'apple.com/in', search: 'https://www.apple.com/in/search/{q}?src=globalnav' },
      samsung: { name: 'Samsung Shop', domain: 'samsung.com/in', search: 'https://www.samsung.com/in/search/?searchvalue={q}' },
    },
  },

  uk: {
    id: 'uk',
    name: 'United Kingdom',
    currency: 'GBP',
    locale: 'en-GB',
    shops: {
      amazon_uk: { name: 'Amazon.co.uk', domain: 'amazon.co.uk', hue: 32, search: 'https://www.amazon.co.uk/s?k={q}' },
      argos: { name: 'Argos', domain: 'argos.co.uk', hue: 0, search: 'https://www.argos.co.uk/search/{q}/' },
      currys: { name: 'Currys', domain: 'currys.co.uk', hue: 270, search: 'https://www.currys.co.uk/search?q={q}' },
      john_lewis: { name: 'John Lewis', domain: 'johnlewis.com', hue: 150, search: 'https://www.johnlewis.com/search?search-term={q}' },
      ebay_uk: { name: 'eBay', domain: 'ebay.co.uk', hue: 210, search: 'https://www.ebay.co.uk/sch/i.html?_nkw={q}' },
      richer_sounds: { name: 'Richer Sounds', domain: 'richersounds.com', hue: 355, search: 'https://www.richersounds.com/catalogsearch/result/?q={q}' },
      scan: { name: 'Scan', domain: 'scan.co.uk', hue: 200, search: 'https://www.scan.co.uk/search?q={q}' },
      very: { name: 'Very', domain: 'very.co.uk', hue: 320, search: 'https://www.very.co.uk/search?q={q}' },
      ao: { name: 'AO.com', domain: 'ao.com', hue: 100, search: 'https://ao.com/search?search={q}' },
      selfridges: { name: 'Selfridges', domain: 'selfridges.com', hue: 52, search: 'https://www.selfridges.com/GB/en/cat/?freeText={q}' },
      tesco: { name: 'Tesco', domain: 'tesco.com', hue: 215, search: 'https://www.tesco.com/groceries/en-GB/search?query={q}' },
      sainsburys: { name: 'Sainsbury’s', domain: 'sainsburys.co.uk', hue: 28, search: 'https://www.sainsburys.co.uk/gol-ui/SearchResults/{q}' },
      asda: { name: 'Asda', domain: 'asda.com', hue: 95, search: 'https://groceries.asda.com/search/{q}' },
      ocado: { name: 'Ocado', domain: 'ocado.com', hue: 285, search: 'https://www.ocado.com/search?entry={q}' },
      waitrose: { name: 'Waitrose', domain: 'waitrose.com', hue: 80, search: 'https://www.waitrose.com/ecom/shop/search?searchTerm={q}' },
      morrisons: { name: 'Morrisons', domain: 'morrisons.com', hue: 45, search: 'https://groceries.morrisons.com/search?entry={q}' },
      boots: { name: 'Boots', domain: 'boots.com', hue: 220, search: 'https://www.boots.com/sitesearch?searchTerm={q}' },
      superdrug: { name: 'Superdrug', domain: 'superdrug.com', hue: 330, search: 'https://www.superdrug.com/search?text={q}' },
      lookfantastic: { name: 'LOOKFANTASTIC', domain: 'lookfantastic.com', hue: 0, search: 'https://www.lookfantastic.com/search?q={q}' },
      asos: { name: 'ASOS', domain: 'asos.com', hue: 0, search: 'https://www.asos.com/search/?q={q}' },
      next: { name: 'Next', domain: 'next.co.uk', hue: 0, search: 'https://www.next.co.uk/search?w={q}' },
      ikea_uk: { name: 'IKEA', domain: 'ikea.com/gb', hue: 52, search: 'https://www.ikea.com/gb/en/search/?q={q}' },
      wayfair_uk: { name: 'Wayfair', domain: 'wayfair.co.uk', hue: 290, search: 'https://www.wayfair.co.uk/keyword.php?keyword={q}' },
      dunelm: { name: 'Dunelm', domain: 'dunelm.com', hue: 160, search: 'https://www.dunelm.com/search?searchTerm={q}' },
      bandq: { name: 'B&Q', domain: 'diy.com', hue: 30, search: 'https://www.diy.com/search?term={q}' },
      waterstones: { name: 'Waterstones', domain: 'waterstones.com', hue: 0, search: 'https://www.waterstones.com/books/search/term/{q}' },
      whsmith: { name: 'WHSmith', domain: 'whsmith.co.uk', hue: 215, search: 'https://www.whsmith.co.uk/search?q={q}' },
      sports_direct: { name: 'Sports Direct', domain: 'sportsdirect.com', hue: 220, search: 'https://www.sportsdirect.com/searchresults?descriptionfilter={q}' },
      jd_sports: { name: 'JD Sports', domain: 'jdsports.co.uk', hue: 50, search: 'https://www.jdsports.co.uk/search/{q}/' },
      decathlon_uk: { name: 'Decathlon', domain: 'decathlon.co.uk', hue: 210, search: 'https://www.decathlon.co.uk/search?Ntt={q}' },
      smyths: { name: 'Smyths Toys', domain: 'smythstoys.com', hue: 210, search: 'https://www.smythstoys.com/uk/en-gb/search/?text={q}' },
    },
    categories: {
      electronics: ['amazon_uk', 'argos', 'currys', 'john_lewis', 'ebay_uk', 'very', 'ao', 'richer_sounds', 'scan', 'selfridges'],
      appliances: ['amazon_uk', 'argos', 'currys', 'john_lewis', 'ao', 'very', 'ebay_uk', 'richer_sounds', 'dunelm', 'bandq'],
      fashion: ['asos', 'next', 'john_lewis', 'selfridges', 'amazon_uk', 'very', 'ebay_uk', 'jd_sports', 'sports_direct', 'argos'],
      beauty: ['boots', 'superdrug', 'lookfantastic', 'john_lewis', 'selfridges', 'amazon_uk', 'asos', 'tesco', 'sainsburys', 'ebay_uk'],
      home: ['ikea_uk', 'wayfair_uk', 'dunelm', 'john_lewis', 'argos', 'amazon_uk', 'very', 'bandq', 'ebay_uk', 'selfridges'],
      grocery: ['tesco', 'sainsburys', 'asda', 'ocado', 'waitrose', 'morrisons', 'amazon_uk', 'boots', 'superdrug', 'ebay_uk'],
      books: ['waterstones', 'whsmith', 'amazon_uk', 'john_lewis', 'ebay_uk', 'argos', 'tesco', 'asda', 'sainsburys', 'selfridges'],
      sports: ['sports_direct', 'jd_sports', 'decathlon_uk', 'amazon_uk', 'argos', 'john_lewis', 'next', 'asos', 'very', 'ebay_uk'],
      kids: ['smyths', 'argos', 'john_lewis', 'amazon_uk', 'very', 'next', 'asda', 'tesco', 'boots', 'ebay_uk'],
      general: ['amazon_uk', 'argos', 'john_lewis', 'ebay_uk', 'very', 'currys', 'tesco', 'asda', 'selfridges', 'next'],
    },
    brands: {
      apple: { name: 'Apple Store', domain: 'apple.com/uk', search: 'https://www.apple.com/uk/search/{q}?src=globalnav' },
      samsung: { name: 'Samsung Shop', domain: 'samsung.com/uk', search: 'https://www.samsung.com/uk/search/?searchvalue={q}' },
    },
  },

  us: {
    id: 'us',
    name: 'United States',
    currency: 'USD',
    locale: 'en-US',
    shops: {
      amazon_us: { name: 'Amazon', domain: 'amazon.com', hue: 32, search: 'https://www.amazon.com/s?k={q}' },
      walmart: { name: 'Walmart', domain: 'walmart.com', hue: 210, search: 'https://www.walmart.com/search?q={q}' },
      target: { name: 'Target', domain: 'target.com', hue: 355, search: 'https://www.target.com/s?searchTerm={q}' },
      best_buy: { name: 'Best Buy', domain: 'bestbuy.com', hue: 220, search: 'https://www.bestbuy.com/site/searchpage.jsp?st={q}' },
      costco: { name: 'Costco', domain: 'costco.com', hue: 0, search: 'https://www.costco.com/CatalogSearch?keyword={q}' },
      ebay_us: { name: 'eBay', domain: 'ebay.com', hue: 210, search: 'https://www.ebay.com/sch/i.html?_nkw={q}' },
      newegg: { name: 'Newegg', domain: 'newegg.com', hue: 28, search: 'https://www.newegg.com/p/pl?d={q}' },
      bh: { name: 'B&H Photo', domain: 'bhphotovideo.com', hue: 200, search: 'https://www.bhphotovideo.com/c/search?q={q}' },
      adorama: { name: 'Adorama', domain: 'adorama.com', hue: 15, search: 'https://www.adorama.com/l/?searchinfo={q}' },
      micro_center: { name: 'Micro Center', domain: 'microcenter.com', hue: 0, search: 'https://www.microcenter.com/search/search_results.aspx?Ntt={q}' },
      home_depot: { name: 'The Home Depot', domain: 'homedepot.com', hue: 25, search: 'https://www.homedepot.com/s/{q}' },
      lowes: { name: 'Lowe’s', domain: 'lowes.com', hue: 220, search: 'https://www.lowes.com/search?searchTerm={q}' },
      wayfair: { name: 'Wayfair', domain: 'wayfair.com', hue: 290, search: 'https://www.wayfair.com/keyword.php?keyword={q}' },
      ikea_us: { name: 'IKEA', domain: 'ikea.com/us', hue: 52, search: 'https://www.ikea.com/us/en/search/?q={q}' },
      macys: { name: 'Macy’s', domain: 'macys.com', hue: 0, search: 'https://www.macys.com/shop/featured/{slug}' },
      nordstrom: { name: 'Nordstrom', domain: 'nordstrom.com', hue: 0, search: 'https://www.nordstrom.com/sr?keyword={q}' },
      kohls: { name: 'Kohl’s', domain: 'kohls.com', hue: 280, search: 'https://www.kohls.com/search.jsp?search={q}' },
      zappos: { name: 'Zappos', domain: 'zappos.com', hue: 205, search: 'https://www.zappos.com/search?term={q}' },
      sephora: { name: 'Sephora', domain: 'sephora.com', hue: 0, search: 'https://www.sephora.com/search?keyword={q}' },
      ulta: { name: 'Ulta Beauty', domain: 'ulta.com', hue: 22, search: 'https://www.ulta.com/search?search={q}' },
      cvs: { name: 'CVS', domain: 'cvs.com', hue: 355, search: 'https://www.cvs.com/search?searchTerm={q}' },
      walgreens: { name: 'Walgreens', domain: 'walgreens.com', hue: 350, search: 'https://www.walgreens.com/search/results.jsp?Ntt={q}' },
      kroger: { name: 'Kroger', domain: 'kroger.com', hue: 220, search: 'https://www.kroger.com/search?query={q}' },
      instacart: { name: 'Instacart', domain: 'instacart.com', hue: 110, search: 'https://www.instacart.com/store/s?k={q}' },
      barnes_noble: { name: 'Barnes & Noble', domain: 'barnesandnoble.com', hue: 150, search: 'https://www.barnesandnoble.com/s/{q}' },
      dicks: { name: 'Dick’s Sporting Goods', domain: 'dickssportinggoods.com', hue: 150, search: 'https://www.dickssportinggoods.com/search/SearchDisplay?searchTerm={q}' },
      rei: { name: 'REI', domain: 'rei.com', hue: 30, search: 'https://www.rei.com/search?q={q}' },
      etsy: { name: 'Etsy', domain: 'etsy.com', hue: 22, search: 'https://www.etsy.com/search?q={q}' },
    },
    categories: {
      electronics: ['amazon_us', 'best_buy', 'walmart', 'target', 'costco', 'newegg', 'bh', 'adorama', 'micro_center', 'ebay_us'],
      appliances: ['amazon_us', 'best_buy', 'home_depot', 'lowes', 'walmart', 'target', 'costco', 'wayfair', 'ebay_us', 'macys'],
      fashion: ['amazon_us', 'nordstrom', 'macys', 'kohls', 'zappos', 'target', 'walmart', 'ebay_us', 'etsy', 'costco'],
      beauty: ['sephora', 'ulta', 'amazon_us', 'target', 'walmart', 'cvs', 'walgreens', 'macys', 'nordstrom', 'kohls'],
      home: ['wayfair', 'ikea_us', 'amazon_us', 'target', 'walmart', 'home_depot', 'lowes', 'costco', 'macys', 'etsy'],
      grocery: ['walmart', 'kroger', 'instacart', 'target', 'costco', 'amazon_us', 'cvs', 'walgreens', 'ebay_us', 'etsy'],
      books: ['amazon_us', 'barnes_noble', 'walmart', 'target', 'costco', 'ebay_us', 'etsy', 'kohls', 'best_buy', 'macys'],
      sports: ['dicks', 'rei', 'amazon_us', 'walmart', 'target', 'kohls', 'costco', 'zappos', 'nordstrom', 'ebay_us'],
      kids: ['amazon_us', 'target', 'walmart', 'kohls', 'costco', 'macys', 'best_buy', 'etsy', 'ebay_us', 'nordstrom'],
      general: ['amazon_us', 'walmart', 'target', 'best_buy', 'costco', 'ebay_us', 'macys', 'kohls', 'home_depot', 'etsy'],
    },
    brands: {
      apple: { name: 'Apple Store', domain: 'apple.com', search: 'https://www.apple.com/us/search/{q}?src=globalnav' },
      samsung: { name: 'Samsung Shop', domain: 'samsung.com/us', search: 'https://www.samsung.com/us/search/searchMain/?searchTerm={q}' },
    },
  },
};

const DEFAULT_REGION = 'in';

const CATEGORIES = {
  electronics: 'Electronics',
  appliances: 'Home appliances',
  fashion: 'Fashion',
  beauty: 'Beauty and health',
  home: 'Home and furniture',
  grocery: 'Groceries',
  books: 'Books',
  sports: 'Sports and fitness',
  kids: 'Baby and toys',
  general: 'General',
};

/** A shop's search page for this product. Only ever an https address we wrote. */
function searchUrl(template, query) {
  const words = String(query || '').trim().replace(/\s+/g, ' ');
  const slug = words.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'search';
  return template
    .split('{q}').join(encodeURIComponent(words))
    .split('{slug}').join(encodeURIComponent(slug));
}

/** Search one site through Google, for a brand store whose own search we do not know. */
function siteSearchUrl(domain, query) {
  return 'https://www.google.com/search?q=' + encodeURIComponent('site:' + domain + ' ' + query);
}

/** Which region a stored or sent id means, falling back to the default. */
function region(id) {
  return REGIONS[id] || REGIONS[DEFAULT_REGION];
}

/** What the page needs to offer a choice and draw the waiting state. */
function regionSummary() {
  return Object.values(REGIONS).map((entry) => ({
    id: entry.id,
    name: entry.name,
    currency: entry.currency,
    locale: entry.locale,
    preview: entry.categories.general.map((id) => ({ name: entry.shops[id].name, hue: entry.shops[id].hue })),
  }));
}

module.exports = { REGIONS, DEFAULT_REGION, CATEGORIES, searchUrl, siteSearchUrl, region, regionSummary };
