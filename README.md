# OnScene landing page

A responsive, dependency-free one-page site for OnScene. Open `index.html` directly,
or serve this folder with any static web server.

## Media handoff

The hero uses the optimized `demovideo-web.mp4`. Original source media is retained
locally, while the deployed page serves lightweight WebP images.

- The single-display frame uses `productimage1.webp`, and the chained-display
  frame uses `multi.webp`.
- The venue gallery uses optimized WebP copies of the mall, nightclub, wedding,
  and gym images.
- Keep the existing class names on the new media elements so the sizing and
  responsive styling continue to work.

## Outbound campaign links

Add an `industry` query parameter to personalize the hero and WhatsApp message:

- `?industry=gym`
- `?industry=mall`
- `?industry=events`
- `?industry=wedding`
- `?industry=nightclub`
- `?industry=property`
- `?industry=automotive`
- `?industry=restaurant`

Campaign parameters can be combined with it, for example:

`?industry=gym&utm_source=linkedin&utm_medium=outreach&utm_campaign=gym_august`

The page pushes page views, important section views, PDF clicks, FAQ opens, and
WhatsApp clicks into `window.dataLayer`. Connect Google Tag Manager or another
analytics tool later without changing the page interactions.

## Before launch

- Contact buttons open WhatsApp for `+27 83 787 5826` with a sector-aware quote enquiry.
- Replace relative Open Graph image paths with absolute URLs once the final
  website domain is connected.
- Update the page title and description if a final positioning line is chosen.
- Compress the hero video and add a poster image for fast first paint.
