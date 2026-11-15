/**
 * Local product categorization and spend allocation for the dashboard.
 *
 * Product titles are classified with a weighted, curated vocabulary rather
 * than a single first-match regex. Strong product phrases and supporting
 * tokens add evidence; close ties and weak evidence stay in Review. Explicit
 * user assignments always win. No product data leaves the extension.
 */
(() => {
  'use strict';

  const CATEGORIES = [
    { id: 'groceries', label: 'Groceries', color: '#3f8f6b', terms: {
      strong: ['fresh produce', 'frozen food', 'ground beef', 'chicken breast', 'whole milk', 'almond milk', 'baby formula', 'protein powder', 'sparkling water', 'coffee pods', 'canned soup', 'peanut butter', 'olive oil', 'paper plates'],
      words: ['grocery', 'groceries', 'milk', 'cheese', 'yogurt', 'eggs', 'bread', 'bagel', 'tortilla', 'cereal', 'oatmeal', 'rice', 'pasta', 'noodle', 'flour', 'sugar', 'salt', 'pepper', 'chicken', 'beef', 'pork', 'turkey', 'sausage', 'bacon', 'ham', 'fish', 'salmon', 'shrimp', 'meat', 'produce', 'lettuce', 'spinach', 'carrot', 'potato', 'tomato', 'onion', 'avocado', 'apple', 'banana', 'orange', 'grape', 'berry', 'strawberry', 'blueberry', 'raspberry', 'snack', 'chip', 'cracker', 'cookie', 'candy', 'chocolate', 'soda', 'water', 'juice', 'coffee', 'tea', 'frozen', 'ice cream', 'soup', 'sauce', 'ketchup', 'mustard', 'mayonnaise', 'condiment', 'bean', 'nut', 'granola', 'oil', 'vinegar', 'spice', 'seasoning', 'popcorn', 'baking', 'dressing', 'salad', 'deli', 'seafood', 'pizza', 'waffle', 'pancake', 'wafer', 'pretzel', 'gummy', 'energy drink', 'sports drink', 'seltzer', 'kombucha', 'watermelon', 'melon', 'peach', 'pear', 'plum', 'pineapple', 'mango', 'cucumber', 'broccoli', 'cauliflower', 'celery', 'pepper', 'mushroom', 'garlic', 'ginger', 'cabbage', 'corn', 'peas', 'beans', 'coconut', 'cream cheese', 'sour cream', 'butter', 'margarine', 'ham', 'lunch meat', 'hot dog', 'ravioli', 'macaroni', 'ramen', 'cracker', 'muffin', 'donut', 'doughnut', 'croissant', 'biscuit', 'pudding', 'gelatin', 'syrup', 'honey', 'jam', 'jelly', 'preserve', 'baby food', 'meal replacement', 'nutritional shake', 'k-cup', 'keurig'],
    } },
    { id: 'household', label: 'Household', color: '#6884a6', terms: {
      strong: ['laundry detergent', 'fabric softener', 'dishwasher detergent', 'dishwashing liquid', 'paper towel', 'toilet paper', 'bath tissue', 'facial tissue', 'trash bag', 'garbage bag', 'cleaning spray', 'disinfecting wipes', 'air freshener', 'food storage bag', 'plastic wrap', 'aluminum foil', 'vacuum bag'],
      words: ['detergent', 'laundry', 'softener', 'dryer sheet', 'dish soap', 'dishwasher', 'tissue', 'toilet paper', 'paper towel', 'trash bag', 'garbage bag', 'cleaner', 'cleaning', 'disinfect', 'bleach', 'sponge', 'scrub', 'mop', 'broom', 'duster', 'air freshener', 'deodorizer', 'storage bag', 'sandwich bag', 'foil', 'plastic wrap', 'parchment', 'wax paper', 'charmin', 'bounty', 'tide', 'gain', 'clorox', 'lysol', 'dawn', 'swiffer', 'glad', 'hefty', 'scott', 'kleenex', 'febreze', 'finish quantum', 'cascade'],
    } },
    { id: 'personal-care', label: 'Personal care', color: '#be7890', terms: {
      strong: ['body wash', 'hand soap', 'toothpaste', 'tooth brush', 'mouth wash', 'shaving cream', 'skin care', 'hair care', 'feminine care', 'menstrual cup', 'cotton swab', 'makeup remover', 'nail polish'],
      words: ['shampoo', 'conditioner', 'toothpaste', 'toothbrush', 'mouthwash', 'deodorant', 'body wash', 'bar soap', 'hand soap', 'lotion', 'moisturizer', 'razor', 'shaving', 'makeup', 'cosmetic', 'mascara', 'lipstick', 'skincare', 'skin care', 'hair care', 'hair color', 'tampon', 'menstrual', 'feminine', 'perfume', 'cologne', 'fragrance', 'nail polish', 'manicure', 'pedicure', 'cotton ball', 'cotton swab', 'floss', 'dental', 'mouth guard', 'hair brush', 'comb', 'hair dryer', 'curling iron', 'flat iron', 'styling gel', 'hairspray', 'pantyliner', 'pad', 'body spray', 'bath bomb', 'bath salts', 'luffa', 'loofah', 'cetaphil', 'cerave', 'dove', 'olay', 'neutrogena', 'loreal', 'garnier', 'tresemme', 'colgate', 'crest', 'gillette', 'venus', 'always', 'tampax', 'secret', 'old spice'],
    } },
    { id: 'clothing', label: 'Clothing & shoes', color: '#8a79ad', terms: {
      strong: ['t shirt', 'sports bra', 'running shoes', 'dress shirt', 'sleep shirt', 'swim suit', 'work boots', 'underwear pack'],
      words: ['clothing', 'apparel', 'shirt', 'tee', 'blouse', 'pants', 'jeans', 'shorts', 'dress', 'skirt', 'sweater', 'hoodie', 'jacket', 'coat', 'sock', 'underwear', 'brief', 'bra', 'pajama', 'shoes', 'sneaker', 'boot', 'sandal', 'slipper', 'swimsuit', 'costume', 'hat', 'glove', 'belt', 'legging', 'tights', 'uniform', 'scrub top', 'scrub pants', 'suit', 'tie', 'scarf', 'cardigan', 'vest', 'raincoat', 'poncho', 'flip flop', 'crocs', 'hanes', 'fruit of the loom', 'levis', 'wrangler', 'lee', 'skechers', 'new balance', 'under armour', 'nike', 'adidas', 'puma'],
    } },
    { id: 'auto', label: 'Auto', color: '#73828d', terms: {
      strong: ['motor oil', 'engine oil', 'car battery', 'windshield wiper', 'brake pads', 'transmission fluid', 'car wash', 'motorcycle helmet', 'license plate frame'],
      words: ['automotive', 'motor oil', 'engine oil', 'car wash', 'car wax', 'vehicle', 'windshield', 'wiper', 'antifreeze', 'brake', 'transmission', 'tire', 'tyre', 'hubcap', 'floor mat', 'jump starter', 'jumper cable', 'air compressor', 'motorcycle', 'motorbike', 'atv', 'trailer hitch', 'car seat cover', 'dash cam', 'car charger', 'car mount', 'oil filter', 'cabin air filter', 'headlight', 'taillight', 'license plate', 'car vacuum', 'auto accessory', 'turtle wax', 'meguiars', 'rain x', 'rainx', 'armor all', 'valvoline', 'mobil 1', 'castrol', 'fram', 'everstart'],
    } },
    { id: 'home-garden', label: 'Home & garden', color: '#b08a57', terms: {
      strong: ['bed sheet', 'sheet set', 'bath towel', 'shower curtain', 'storage bin', 'frying pan', 'dining table', 'patio furniture', 'garden hose', 'light bulb', 'curtain panel'],
      words: ['furniture', 'bedding', 'sheet', 'comforter', 'pillow', 'blanket', 'towel', 'curtain', 'rug', 'lamp', 'light bulb', 'cookware', 'frying pan', 'saucepan', 'dinnerware', 'flatware', 'plate set', 'storage bin', 'home decor', 'garden', 'gardening', 'planter', 'plant pot', 'lawn', 'patio', 'mattress', 'duvet', 'quilt', 'pillowcase', 'bath mat', 'shower curtain', 'shower liner', 'bathroom accessory', 'wall art', 'picture frame', 'clock', 'vase', 'candle', 'home fragrance', 'decorative', 'artificial plant', 'hose', 'sprinkler', 'weed', 'soil', 'mulch', 'fertilizer', 'seed', 'flower', 'tree', 'shrub', 'grill', 'barbecue', 'bbq', 'kitchen utensil', 'knife set', 'cutting board', 'bakeware', 'food container', 'mixing bowl', 'trash can', 'wastebasket', 'bookshelf', 'desk', 'office chair', 'dresser', 'nightstand', 'ottoman', 'recliner', 'mason jar', 'storage shelf', 'tool', 'drill', 'screwdriver', 'wrench', 'hardware', 'paint', 'caulk', 'adhesive', 'batteries', 'battery', 'extension cord', 'power strip', 'smoke detector', 'doorbell', 'lockset', 'doormat', 'step stool', 'hamper', 'iron', 'ironing board', 'sewing', 'upholstery'],
    } },
    { id: 'electronics', label: 'Electronics', color: '#5a9aa5', terms: {
      strong: ['phone charger', 'usb c cable', 'wireless earbuds', 'bluetooth speaker', 'external hard drive', 'memory card', 'screen protector', 'wifi router', 'charging station'],
      words: ['electronics', 'television', 'smart tv', ' tv', 'laptop', 'computer', 'desktop', 'tablet', 'smartphone', 'cell phone', 'phone charger', 'usb', 'hdmi', 'headphone', 'earbud', 'speaker', 'camera', 'printer', 'monitor', 'keyboard', 'mouse', 'router', 'memory card', 'power bank', 'charging cable', 'charger', 'webcam', 'microphone', 'projector', 'smartwatch', 'fitness tracker', 'bluetooth', 'wireless', 'gaming headset', 'screen protector', 'phone case', 'tablet case', 'hard drive', 'ssd', 'flash drive', 'surge protector', 'ring light', 'gopro', 'roku', 'fire tv', 'apple watch', 'iphone', 'samsung galaxy', 'airpods', 'beats', 'jbl', 'anker', 'logitech', 'canon', 'epson', 'hp printer', 'dell', 'acer', 'lenovo'],
    } },
    { id: 'health', label: 'Health & wellness', color: '#ba786e', terms: {
      strong: ['first aid kit', 'blood pressure monitor', 'pain reliever', 'cough and cold', 'allergy medicine', 'vitamin d', 'heating pad', 'medical mask', 'glucose monitor'],
      words: ['vitamin', 'supplement', 'medicine', 'medication', 'pain relief', 'ibuprofen', 'acetaminophen', 'aspirin', 'first aid', 'bandage', 'thermometer', 'allergy', 'cough', 'cold flu', 'antacid', 'probiotic', 'heating pad', 'blood pressure', 'pharmacy', 'medical', 'health', 'protein', 'electrolyte', 'melatonin', 'sleep aid', 'fiber supplement', 'fish oil', 'magnesium', 'calcium', 'multivitamin', 'prenatal', 'cbd', 'knee brace', 'ankle brace', 'wrist brace', 'compression sock', 'hearing aid', 'incontinence', 'adult diaper', 'glucose', 'diabetic', 'eye drops', 'contact lens solution', 'saline solution', 'nebulizer', 'pulse oximeter', 'cane', 'walker', 'crutch', 'mobility', 'blood glucose', 'iron supplement', 'biotin', 'coq10', 'zinc', 'ensure', 'boost nutrition', 'band aid', 'neosporin'],
    } },
    { id: 'baby', label: 'Baby & toddler', color: '#cf879a', terms: {
      strong: ['baby wipes', 'baby formula', 'infant formula', 'diaper pail', 'car seat', 'stroller travel system', 'baby monitor', 'sippy cup'],
      words: ['baby', 'infant', 'newborn', 'toddler', 'diaper', 'nappy', 'formula', 'stroller', 'crib', 'pacifier', 'teether', 'sippy cup', 'baby food', 'baby monitor', 'baby bottle', 'bottle nipple', 'changing table', 'diaper bag', 'playard', 'play yard', 'high chair', 'booster seat', 'breast pump', 'nursing pad', 'swaddle', 'burp cloth', 'baby blanket', 'baby shampoo', 'baby lotion', 'baby gate', 'onesie', 'car seat cover', 'gerber baby', 'huggies', 'pampers', 'l luvs', 'lansinoh', 'frida baby', 'graco stroller'],
    } },
    { id: 'pets', label: 'Pets', color: '#a47b5a', terms: {
      strong: ['dog food', 'cat food', 'cat litter', 'litter box', 'puppy pads', 'fish food', 'bird seed', 'pet carrier'],
      words: ['pet', 'dog', 'puppy', 'cat', 'kitten', 'litter', 'aquarium', 'fish food', 'bird seed', 'hamster', 'guinea pig', 'flea', 'rawhide', 'pet bed', 'pet toy', 'dog leash', 'dog collar', 'cat tree', 'scratching post', 'pet crate', 'kennel', 'pet carrier', 'grooming', 'dog treat', 'cat treat', 'chew toy', 'poop bag', 'waste bags', 'aquarium filter', 'fish tank', 'reptile', 'bird cage', 'wild bird', 'pet stain', 'odor eliminator', 'rover', 'purina', 'pedigree', 'blue buffalo', 'meow mix', 'friskies', 'fancy feast', 'temptations', 'tidy cats', 'arm and hammer litter', 'fresh step'],
    } },
    { id: 'sports-outdoors', label: 'Sports & outdoors', color: '#558c83', terms: {
      strong: ['camping tent', 'sleeping bag', 'fishing rod', 'basketball hoop', 'yoga mat', 'exercise bike', 'life jacket', 'hiking backpack'],
      words: ['sports', 'fitness', 'exercise', 'dumbbell', 'barbell', 'yoga', 'bicycle', 'bike helmet', 'camping', 'tent', 'sleeping bag', 'fishing', 'hunting', 'basketball', 'football', 'soccer', 'baseball', 'tennis', 'golf', 'kayak', 'cooler', 'treadmill', 'elliptical', 'resistance band', 'weight bench', 'workout', 'athletic', 'volleyball', 'pickleball', 'badminton', 'skateboard', 'scooter', 'roller skate', 'trampoline', 'pool', 'swimming', 'life jacket', 'hiking', 'backpack', 'hydration pack', 'camp stove', 'lantern', 'binocular', 'tackle box', 'fishing reel', 'golf club', 'soccer ball', 'football', 'baseball bat', 'cleat', 'helmet', 'protective gear', 'thermarest', 'coleman', 'yeti cooler', 'igloo cooler'],
    } },
    { id: 'office-school', label: 'Office & school', color: '#777eb0', terms: {
      strong: ['printer paper', 'copy paper', 'spiral notebook', 'composition book', 'mechanical pencil', 'school backpack', 'index card'],
      words: ['office supplies', 'school supplies', 'notebook', 'binder', 'pencil', 'pen', 'marker', 'highlighter', 'printer paper', 'copy paper', 'folder', 'index card', 'stapler', 'envelope', 'backpack', 'calculator', 'crayon', 'glue stick', 'scissors', 'whiteboard', 'dry erase', 'construction paper', 'notepad', 'planner', 'calendar', 'label maker', 'ink cartridge', 'toner', 'desk organizer', 'paper clip', 'push pin', 'ruler', 'protractor', 'art supply', 'school glue', 'sharpie', 'post it', 'post-it', 'expo marker', 'filler paper', 'graph paper', 'pencil sharpener', 'lunchbox', 'lunch bag', 'school uniform'],
    } },
    { id: 'entertainment', label: 'Toys, books & games', color: '#9b78a8', terms: {
      strong: ['board game', 'video game', 'building set', 'action figure', 'coloring book', 'puzzle set', 'doll house'],
      words: ['toy', 'board game', 'card game', 'puzzle', 'doll', 'lego', 'building set', 'action figure', 'video game', 'gaming console', 'blu ray', 'dvd', 'movie', 'book', 'novel', 'coloring book', 'music cd', 'vinyl record', 'stuffed animal', 'plush', 'remote control car', 'rc car', 'craft kit', 'play doh', 'play-doh', 'hot wheels', 'barbie', 'nerf', 'fisher price', 'hasbro', 'mattel', 'nintendo switch', 'playstation', 'xbox', 'kindle book', 'comic book', 'trading cards', 'pokemon cards', 'party game', 'musical instrument', 'guitar', 'keyboard piano', 'craft supplies'],
    } },
    { id: 'uncategorized', label: 'Needs a category', color: '#b6b3aa', terms: { strong: [], words: [] } },
  ];

  const BY_ID = new Map(CATEGORIES.map((category) => [category.id, category]));

  // Walmart's own department for a product (the id that leads its category
  // path, "0:<department>:…"), mapped onto the categories above. A department
  // that is not listed falls back to the name-based suggestion.
  const DEPARTMENT_CATEGORY = {
    '976759': 'groceries',
    '1115193': 'household',
    '1085666': 'personal-care', '1005862': 'personal-care',
    '976760': 'health', '5431': 'health',
    '3944': 'electronics',
    '4044': 'home-garden', '1072864': 'home-garden', '5428': 'home-garden',
    '5438': 'clothing', '3891': 'clothing',
    '5440': 'pets',
    '5427': 'baby',
    '4171': 'entertainment', '3920': 'entertainment', '4096': 'entertainment', '4104': 'entertainment', '2636': 'entertainment', '2637': 'entertainment',
    '4125': 'sports-outdoors',
    '91083': 'auto',
    '1229749': 'office-school', '1334134': 'office-school',
  };

  /** Category id for a Walmart category path, or null when the department is not known. */
  function departmentCategory(categoryPathId) {
    const parts = String(categoryPathId || '').split(':').filter(Boolean);
    const department = parts[0] === '0' ? parts[1] : parts[0];
    const categoryId = department ? DEPARTMENT_CATEGORY[department] : null;
    return categoryId && BY_ID.has(categoryId) ? categoryId : null;
  }
  const norm = (value) => String(value || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
  const round1 = (value) => Math.round((Number(value) || 0) * 10) / 10;

  function hasPhrase(title, phrase) {
    return ` ${title} `.includes(` ${norm(phrase)} `);
  }

  function classifyNameDetailed(name) {
    const title = norm(name);
    if (!title) return { categoryId: 'uncategorized', confidence: 0, scores: {} };
    const scores = {};
    for (const category of CATEGORIES) {
      if (category.id === 'uncategorized') continue;
      let score = 0;
      category.terms.strong.forEach((phrase) => { if (hasPhrase(title, phrase)) score += 4; });
      category.terms.words.forEach((term) => {
        if (hasPhrase(title, term)) score += norm(term).includes(' ') ? 2 : 1.75;
      });
      if (score) scores[category.id] = score;
    }
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return { categoryId: 'uncategorized', confidence: 0, scores };
    const [winner, top] = ranked[0];
    const next = ranked[1] ? ranked[1][1] : 0;
    const margin = top - next;
    // A clear product phrase or multiple independent clues can classify a
    // product. Weak or conflicting clues remain editable in Needs a category.
    if (top < 1.75 || (ranked.length > 1 && margin < 1.75)) {
      return { categoryId: 'uncategorized', confidence: top ? Math.min(0.49, top / (top + next + 1)) : 0, scores };
    }
    const confidence = Math.min(0.99, 0.72 + Math.min(0.2, (margin / Math.max(top, 1)) * 0.2) + (top >= 4 ? 0.07 : 0));
    return { categoryId: winner, confidence, scores };
  }

  function classifyName(name) { return classifyNameDetailed(name).categoryId; }

  function buildCategorySummary(itemIndex, assignments = {}) {
    const buckets = new Map();
    let totalSpend = 0;
    const orders = new Set();
    const refundedProducts = [];
    let refundedTotal = 0;
    let manuallyAssignedCount = 0;

    (Array.isArray(itemIndex) ? itemIndex : []).forEach((entry) => {
      if (!entry) return;
      const allPurchases = Array.isArray(entry.purchases) ? entry.purchases : [];
      const purchases = allPurchases.map((purchase) => ({
        ...purchase,
        categorySpend: purchase && purchase.purchasedLineTotal !== undefined
          ? Number(purchase.purchasedLineTotal) || 0
          : Number(purchase && purchase.lineTotal) || 0,
        refundSpend: Number(purchase && purchase.refundedLineTotal) || 0,
      }));
      const refundSpend = round2(purchases.reduce((sum, purchase) => sum + purchase.refundSpend, 0));
      if (refundSpend > 0) {
        const refundOrders = new Set(purchases.filter((purchase) => purchase.refundSpend > 0).map((purchase) => String(purchase.orderNumber || '')).filter(Boolean));
        refundedProducts.push({
          key: entry.itemId ? `id:${String(entry.itemId).trim()}` : `name:${norm(entry.name)}`,
          name: String(entry.name || ''),
          totalSpent: refundSpend,
          timesBought: refundOrders.size,
          totalQty: round2(purchases.reduce((sum, purchase) => sum + (Number(purchase.refundedQuantity) || 0), 0)),
        });
        refundedTotal += refundSpend;
      }
      const spendPurchases = purchases.filter((purchase) => purchase.categorySpend > 0);
      if (!spendPurchases.length) return;
      const nameKey = `name:${norm(entry.name)}`;
      const itemKey = entry.itemId ? `id:${String(entry.itemId).trim()}` : nameKey;
      const assignedValue = assignments && (assignments[itemKey] || assignments[nameKey]);
      const assigned = BY_ID.has(assignedValue) ? assignedValue : null;
      const prediction = classifyNameDetailed(entry.name);
      const fromWalmart = departmentCategory(entry.categoryPathId);
      const categoryId = assigned || fromWalmart || prediction.categoryId;
      const definition = BY_ID.get(categoryId) || BY_ID.get('uncategorized');
      let bucket = buckets.get(definition.id);
      if (!bucket) {
        bucket = { id: definition.id, label: definition.label, color: definition.color, totalSpent: 0, products: [], orderNumbers: new Set() };
        buckets.set(definition.id, bucket);
      }
      let spent = 0;
      let quantity = 0;
      const productOrders = new Set();
      spendPurchases.forEach((purchase) => {
        spent += purchase.categorySpend;
        quantity += Number(purchase.quantity) || 0;
        const order = String(purchase.orderNumber || '');
        if (order) { productOrders.add(order); bucket.orderNumbers.add(order); orders.add(order); }
      });
      spent = round2(spent);
      bucket.totalSpent += spent;
      bucket.products.push({
        key: itemKey,
        nameKey,
        name: String(entry.name || ''),
        totalSpent: spent,
        timesBought: productOrders.size || purchases.length,
        totalQty: round2(quantity),
        confidence: assigned ? 1 : (fromWalmart ? 0.97 : prediction.confidence),
        manual: Boolean(assigned),
        suggestedCategoryId: fromWalmart || prediction.categoryId,
        source: assigned ? 'manual' : (fromWalmart ? 'walmart' : 'name'),
      });
      if (assigned) manuallyAssignedCount += 1;
      totalSpend += spent;
    });

    totalSpend = round2(totalSpend);
    const categories = [...buckets.values()].map((bucket) => {
      const totalSpent = round2(bucket.totalSpent);
      return {
        id: bucket.id, label: bucket.label, color: bucket.color, totalSpent,
        percent: totalSpend > 0 ? round1((totalSpent / totalSpend) * 100) : 0,
        itemCount: bucket.products.length,
        orderCount: bucket.orderNumbers.size,
        products: bucket.products.sort((a, b) => b.totalSpent - a.totalSpent || a.name.localeCompare(b.name)),
      };
    }).sort((a, b) => b.totalSpent - a.totalSpent || a.label.localeCompare(b.label));
    refundedTotal = round2(refundedTotal);
    if (refundedTotal > 0) {
      const refundOrderCount = new Set((Array.isArray(itemIndex) ? itemIndex : []).flatMap((entry) =>
        (Array.isArray(entry && entry.purchases) ? entry.purchases : [])
          .filter((purchase) => Number(purchase && purchase.refundedLineTotal) > 0)
          .map((purchase) => String(purchase.orderNumber || '')).filter(Boolean)
      )).size;
      categories.push({
        id: 'refunded', label: 'Refunded', color: '#4f927e', totalSpent: refundedTotal,
        percent: 0, itemCount: refundedProducts.length, orderCount: refundOrderCount,
        products: refundedProducts.sort((a, b) => b.totalSpent - a.totalSpent || a.name.localeCompare(b.name)),
      });
    }
    const review = categories.find((category) => category.id === 'uncategorized');
    const needsReviewSpend = review ? review.totalSpent : 0;
    return {
      totalSpend,
      refundedTotal,
      categorizedSpend: round2(totalSpend - needsReviewSpend),
      uncategorizedSpend: needsReviewSpend,
      needsReviewSpend,
      reviewItemCount: review ? review.itemCount : 0,
      manualItemCount: manuallyAssignedCount,
      coveragePercent: totalSpend > 0 ? round1(((totalSpend - needsReviewSpend) / totalSpend) * 100) : 0,
      itemCount: categories.reduce((sum, category) => sum + category.itemCount, 0),
      orderCount: orders.size,
      categories,
    };
  }

  const CategoryStats = { CATEGORIES, normalizeName: norm, classifyName, classifyNameDetailed, departmentCategory, buildCategorySummary };
  if (typeof module !== 'undefined' && module.exports) module.exports = CategoryStats;
  (typeof self !== 'undefined' ? self : globalThis).CategoryStats = CategoryStats;
})();
