# OnScene landing page

A responsive, dependency-free one-page site for OnScene. Open `index.html` directly,
or serve this folder with any static web server.

## Media handoff

The hero uses the higher-quality `demovideo.mp4` on desktop and mobile, with
automatic preloading and no poster image. Other page images use lightweight WebP files.

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

## Admin portal (`/admin`)

A password-protected back office for the screen fleet and rental calendar.

- **Screens**: add, edit and delete screens by the unique number on each frame
  (letters, digits and dashes, stored upper-case). Each screen has an optional label,
  a status (Available / Maintenance / Retired) and notes. A screen that appears on any
  rental cannot be deleted. Remove it from those rentals first, or mark it Retired.
- **Clients**: add, edit and delete clients with a name, email, cellphone number and a
  default address. A client with rentals or files cannot be deleted.
- **Photos & videos**: each client has a **Media** panel, opened from the Clients tab or
  from any of their bookings in the calendar or list. Drag in photos and videos up to 5 GB
  each and watch the upload progress. Preview them, then **Download** one or **Download all**.
  Files keep their original quality and name.
- **Rental days**: switch between a month **Calendar** and a **List** (current & upcoming,
  past, all). Filter either view by screen. Selecting a day shows who has which screens
  and which available screens are free. Each rental links to an existing client and one or
  more existing screens, runs from a first to a last day (inclusive), and has notes.
  Its address is prefilled from the client's default and can be changed for that booking
  only. You can also add a new client from inside the rental form. The server refuses to
  double-book a screen on overlapping days.

### Setup (Supabase)

1. In the Supabase dashboard, open your project → **SQL Editor** and run each file in
   `supabase/migrations/` once, oldest first:
   `20261102000000_admin_fleet.sql`, `20261103000000_clients.sql`, then
   `20261104000000_client_media.sql`. If you use the
   Supabase CLI instead, run `supabase link` and then `supabase db push`.
2. In Vercel → Project → Settings → Environment Variables, add:
   - `SUPABASE_URL`: Project Settings → API → Project URL.
   - `SUPABASE_SECRET_KEY`: Project Settings → API Keys → a **secret** key (`sb_secret_…`).
     The legacy `service_role` key also works, as `SUPABASE_SERVICE_ROLE_KEY`.
     This key bypasses row-level security. Keep it server-side only and never put it in browser code.
3. Choose the admin password (at least 5 characters) and set it as `ADMIN_PASSWORD` in
   Vercel Production, then redeploy. For local use, run `npm run admin:setup`. It asks
   for the password with hidden typing and saves it to `.env.local`. You can also pass it
   directly: `npm run admin:setup -- "your password"`. Run it again to change it.

Only the Vercel functions talk to Supabase. Every table has row-level security enabled
with no policies, and table grants are revoked from `anon`/`authenticated`, so the
public anon key can read nothing. Free-tier projects pause after a period without
activity; if the admin reports a database error, check whether the project needs restoring in the dashboard.

Sign-in mirrors the Smelt dispatch desk: opaque 12-hour sessions stored in
`admin_sessions`, in an HttpOnly, SameSite=Strict cookie (`onscene_admin`), login rate limiting
(10 per IP and 100 total per 15 minutes), same-origin checks on every change, and
`no-store` responses. Changing the password (and redeploying) signs everyone out.

### Data model

- `screens`: `number` is unique and upper-case. Status is `available`, `maintenance` or `retired`.
- `clients`: name, email, phone, default `address`.
- `rentals`: `client_id` (must exist; a client with rentals cannot be deleted), the booking
  `address`, notes, and `start_date`–`end_date` (inclusive).
- `rental_screens`: links rentals to screens. A screen on any rental cannot be deleted
  (`on delete restrict`). An exclusion constraint makes Postgres itself refuse two rentals
  holding the same screen on overlapping days, even for concurrent saves or edits made in
  the Supabase table editor.
- `save_rental(...)`: creates or updates a rental and its screens in one transaction.
  An empty address takes the client's default.

- `client_media`: one row per file (client, R2 object key, original name, type, size). It is
  `pending` until the server confirms the upload reached R2 with the right size.

### Photo & video storage (Cloudflare R2)

Files go straight between the browser and R2 using signed links that expire. Upload links
last 6 hours and download links 15 minutes. Files never pass through Vercel, so its
function size limits don't apply. The bucket stays private: only someone signed in to the
admin can get a link.

1. Cloudflare dashboard → **R2** → **Create bucket**, e.g. `onscene-media` (keep it private).
2. Open the bucket → **Settings** → **CORS policy** and add this, with your real domain:

   ```json
   [
     {
       "AllowedOrigins": ["https://your-domain.co.za", "http://localhost:3000"],
       "AllowedMethods": ["PUT", "GET", "HEAD"],
       "AllowedHeaders": ["content-type"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   Without this, the browser blocks uploads and the admin tells you to check CORS.
3. R2 → **Manage API tokens** → **Create API token** with **Object Read & Write**, limited
   to that bucket. Copy the **Access Key ID** and **Secret Access Key**. They are shown only once.
4. Add these to Vercel, and to `.env.local` for local use: `R2_ACCOUNT_ID` (shown on the R2
   overview page), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET`. Redeploy.

The R2 free tier includes 10 GB of storage, and downloads are free. Each file can be up to
5 GB, the largest single upload R2 accepts. **Download all** downloads the files one after
another, so the browser may ask once to allow multiple downloads. Deleting a file removes
it from R2 straight away.

### Local development

```sh
npm install
cp .env.example .env.local   # optional: fill in to use your Supabase project
npm run dev     # http://localhost:3000/admin/
npm test        # API tests + migration checks in an in-process Postgres (PGlite)
```

Without `SUPABASE_URL`, `npm run dev` keeps data in memory until it stops. Without
`R2_BUCKET`, it keeps uploaded files in memory too. Without
`ADMIN_PASSWORD`, it uses `onscene-dev`.
