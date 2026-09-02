# Evigrade Skin

Chrome extension that reads the INCI list on a cosmetics product page and marks every ingredient with an evidence rating, without asking you to copy anything anywhere.

[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/ffipaidpbkbfhdhmijhncneohohbhfml) · [evigrade.com](https://www.evigrade.com/en)

## What it does

Open a product page in a supported store. The extension finds the ingredient list, colours each entry and adds a summary panel underneath.

- Green means there are randomised trials behind the ingredient
- Yellow means the evidence is thin, unstable or limited to single studies
- Red means the mechanism does not hold up: the molecule does not cross the skin barrier, or the claimed effect has been tested and not found

Beyond the rating:

- Position in the INCI list is read as a concentration signal, since EU rules order ingredients by decreasing share. Alcohol or SLS inside the first five entries gets an irritation warning
- Allergen potential and pregnancy status per ingredient
- Formaldehyde releasers are flagged, with a separate combined warning when a formula holds two or more
- Pairs that are only a problem together, such as bronopol next to a DEA or TEA amine and the nitrosamine risk that follows
- UV filters that can stain fabric, avobenzone and oxybenzone among them
- Manual mode for pasting an ingredient list from any source
- A personal stop list of allergens and ingredients to avoid
- Side by side comparison of several products

Interface and data in English, Spanish and Russian.

## Where it works

Retailer coverage lives in `host_permissions` in [manifest.json](manifest.json). Currently Sephora, Douglas, Notino, Ulta, Boots, Lookfantastic, Cult Beauty, Beauty Bay, dm, Rossmann, Druni, Primor, Maquillalia, El Corte Inglés, iHerb, Wildberries, Ozon and Gold Apple, across their EU, UK, US and CIS domains.

## How it is built

Manifest V3, no bundler, plain JavaScript so the shipped package matches this source line for line.

| File | Role |
|---|---|
| `content/parser.js` | Finds the INCI block on a retailer page, requests ratings, draws highlights and the floating panel |
| `content/site-bridge.js` | Bridge between the page and the extension on evigrade.com itself |
| `api-contract.js` | Endpoint URLs and the API version constant, mirrored from the site's TypeScript contract |
| `background.js` | Service worker: telemetry queue, opt-out, daily heartbeat |
| `popup.js` / `compare.js` | Toolbar panel with manual mode and the comparison screen |
| `i18n.js`, `_locales/` | Interface strings for EN, ES, RU |

The extension holds no ingredient database of its own. Ratings come from the Evigrade API, so a correction on the site reaches users without a store update.

## Privacy

No account is required. The pregnancy toggle and the stop list stay in `chrome.storage` on the device and are never sent anywhere. Telemetry covers installation heartbeat and anonymous usage events, and can be switched off in settings. Full text: [evigrade.com/en/privacy](https://www.evigrade.com/en/privacy).

## Editorial position

Evigrade is an educational reference, not a diagnostic tool and not medical advice. Every rating is traceable to a primary source: CIR reviews, SCCS opinions, EU Cosmetics Regulation annexes, Cochrane reviews and original publications. Where evidence is missing the card says so instead of guessing.

## Local development

```sh
# Chrome → chrome://extensions → Developer mode → Load unpacked → this folder
```

## Reporting a problem

Wrong rating, a broken parser on some store, a missing ingredient: open an issue with the product URL. Editorial corrections are welcome, they land in the public catalogue.

## License

Source is published for review and transparency. All rights reserved, no permission is granted to redistribute or publish derived extensions.
