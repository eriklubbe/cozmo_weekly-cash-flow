# Cozmo Weekly Cash Flow

A browser-based weekly cash flow forecast for Cozmo. It runs entirely
in the browser — no server, no build step. The app lives in `docs/`: open
`docs/index.html`, or publish it with GitHub Pages (see below).

```
docs/                 the app (index.html, app.js, styles.css, assets/)
docs/access.js        password access, written by the app (token encrypted with the password)
data/cashflow.json    the shared forecast, written by the app (plain JSON)
```

## Tabs

**Overview** — one row per customer, supplier and recurring payment, one column
per week (Monday–Sunday), plus a *Later* column for anything beyond the window.
The summary at the top shows cash at the start of each week, cash in, cash out,
net in/(out) and cash at the end of the week.
A line chart above the table plots cash at the end of each week, with the low
point and the last week labelled; hover a week for its start, cash in and cash out.

- Click any amount to see the invoices behind it (invoice number, due date,
  expected date, amount).
- Click a *Cash in* or *Cash out* total (a week, Overdue or the 13-week Total)
  to see the top 10 customers or suppliers behind it, with their share; click a
  name to open its invoices for that week.
- Drag an amount onto another week to move every invoice in it, or drag a single
  invoice from the drill-down list. You can also type a new expected date.
- Moved items keep a gold dot; items already overdue are shown in week 1 with a
  red dot. *Reset* puts an item back on its due date.
- *Exclude* leaves a Xero invoice out of the forecast (e.g. disputed); restore it
  from Data & import. *Undo* (or Ctrl/Cmd+Z) reverses the last change.

**Recurring payments** — direct debits and other payments with no bill in Xero
(rent, payroll, loans, subscriptions). Set name, amount, frequency (weekly,
fortnightly, monthly, quarterly, annually) and the day of the month (or day of
the week). Individual occurrences can be moved or skipped on the Overview.

**Data & import** — opening cash balance, forecast start and length, the Xero
CSV importer, the full list of invoices and bills, and backup / restore.

## Importing from Xero

1. Xero → *Sales › Invoices › Awaiting payment* → **Export** (CSV).
2. Xero → *Purchases › Bills › Awaiting payment* → **Export** (CSV).
3. On *Data & import*, pick the file. Columns are matched automatically
   (`ContactName`, `InvoiceNumber`, `DueDate`, `InvoiceAmountDue`, `Status`,
   `Type`); change any mapping in the preview before importing.

Xero repeats an invoice on every line item — the importer keeps one row per
invoice. Paid, voided and (by default) draft invoices are skipped, credit notes
come in as negatives. Re-importing a file replaces the previous import of that
type and keeps any dates you had moved, so the weekly routine is: export, import,
update the opening cash balance.

## Sharing through GitHub

On *Data & import → Shared storage on GitHub*, connect with a GitHub token. From
then on the forecast is read from and saved to `data/cashflow.json` in this repo:
every change is committed automatically a moment after you make it, so everyone
sees the same numbers and the commit history shows what changed and when.

- Changes other people save are picked up when you return to the tab, and every
  minute while it is open.
- If two people edit at the same time, a banner asks whether to load their
  version or keep yours — nothing is overwritten silently.
- A read-only token opens the forecast in view mode.

Before connecting, the forecast is kept in the browser only. **Download backup**
works in both modes.

## Password access

The password guards the app in the browser; the forecast stays readable in the
repo for anyone with GitHub access.

Once connected with your token, set a password under *Password access*. The app
saves your GitHub token in `docs/access.js`, encrypted with the password
(AES-256-GCM, key derived with PBKDF2, 600,000 rounds). Anyone opening the app
without a token of their own gets a password screen; the password unlocks the
token and the app loads the forecast. They don't need a GitHub account, and
their edits are committed under your account. *Keep me signed in* remembers the
password on that computer and **Lock** in the top bar forgets it; nothing is
cached in the browser of someone signed in by password.

Opening the app with your own token skips the password. To revoke access, set a
new password; to also cut off a browser that is already signed in, replace your
GitHub token first and then set the password again.

## Hosting

The repo is private. GitHub Pages can publish a private repo on a paid GitHub
plan (Pro, Team or Enterprise): *Settings → Pages → Deploy from a branch → main,
/docs*. Only `docs/` is published, not the data file, and the published
`access.js` holds only the encrypted token. A Pages site is reachable by anyone
with the link, so the password is what protects it — use a long one.

**Vercel** also works with the private repo: import it as a new project with
*Root Directory* `docs`, framework *Other*, no build command. `docs/vercel.json`
skips redeploys when only the forecast data changed and keeps the page out of
search engines.

Without hosting, anyone with repo access can download the `docs/` folder and open
`index.html` locally.

A direct Xero connection is planned to replace the CSV step.

## Company settings

Everything specific to one company is in three places, so the app can be copied
for another company:

- `docs/config.js` — company name, logo, GitHub repository, the name the
  browser saves data under, the credit facility's name and the bank.
- The top block of `docs/styles.css` — colours, fonts and design switches.
- `docs/assets/` — logo and badge.

A copy for another company gets its own repo, Vercel project, GitHub token and
password, and must not include `data/` or `docs/access.js`.

## Theme and logo

Colours and fonts are tokens at the top of `styles.css`. Put the logo at
`docs/assets/logo.png` (see `docs/assets/README.md`).
