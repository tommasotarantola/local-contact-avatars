# Local Contact Avatars

Thunderbird add-on that shows sender avatars in the message list, using only
the photos already stored in your address books. 

There are two kind of contacts:
- **Person contact**: the contact whose email address equals the sender's,
  shown as a circle.
- **Domain Contact**: a card for a whole sender domain (a company, a service),
  shown as a rounded square.

If there is no match it shows the sender's initials.
It never connects to the
Internet.

## Install

From Thunderbird: menu > **Add-ons and Themes**, search "Local Contact Avatars", install, restart.

Or install the file directly: download `release/local-contact-avatars-0.9.0.xpi`, then **Add-ons and Themes** > gear icon > **Install Add-on From File...**, restart.

Thunderbird warns that the add-on has full access. That is because it uses an Experiment API to draw in the message list; it does not use that access for anything else (see below).

## Contacts

Person contacts need nothing. The add-on reads every address book Thunderbird has, local or synced (Google, iCloud, Nextcloud, any CardDAV). If a contact has a photo, mail from that address gets it.

Domain Contacts are cards for companies and services, which write from many different addresses. One card covers a whole sender domain. I keep a pack for common Italian senders (banks, couriers, telcos, stores, universities) in `release/domain-contacts-it.vcf`. It is a vCard file, the usual format for exchanging contacts.

To import it: menu > **Tools** > **Import** > **Address Books** > **vCard file**, pick the file, name the address book (for example "Domain Contacts").

To update the pack, delete that address book and import the new file. Thunderbird does not merge cards, it would duplicate them.

To make your own card, save this as a `.vcf` file and import it the same way. Thunderbird's editor cannot set these fields, but once imported you can change name and photo from there.

```
BEGIN:VCARD
VERSION:4.0
KIND:org
CATEGORIES:domain-contact
FN:Company name
URL:https://sender-domain.example/
PHOTO:data:image/png;base64,<128x128 PNG in base64>
END:VCARD
```

The URL host must be the domain after the `@` in the From header of a real message, not the company website: senders often use a subdomain, and each subdomain needs its own card. `base64 -w0 logo.png` gives the PHOTO text.

## How it works

| | Person contact | Domain Contact |
|---|---|---|
| Card | any contact with a photo | `KIND:org`, `CATEGORIES:domain-contact`, one `https://<domain>/` URL, embedded photo |
| Match | sender email equals a contact email | sender domain equals the URL host |
| Shape | circle | rounded square |

At start, and after any change to the address books, all contacts are indexed in memory. For every row in the message list the From address is parsed with Thunderbird's own parser and looked up: exact email first, then exact domain, otherwise initials. A person contact wins over a Domain Contact.

A match means the domain is in your address book, nothing more. It does not check SPF, DKIM or DMARC.

## Security

The xpi is a plain zip of `extension/`. No build step, no minified code, no bundled library: what you read is what runs.

- Permissions: `messagesRead`, `addressBooks`. No host permissions.
- No network code: no `fetch`, `XMLHttpRequest` or `WebSocket` anywhere.
- Photos are read only when embedded in the card or in a local file. A `PHOTO` that is an https URL is skipped, so Thunderbird never downloads anything.
- Only the From header is read. Nothing is written to contacts or to disk.
- `extension/api/headerApi.js` is the Experiment API: privileged code that puts one element per row into the message list, because no standard WebExtension API can. When the add-on is disabled it removes everything it added.

`./build.sh` zips `extension/` into `release/` and writes `SHA256SUMS`.

## Limitations

- Thunderbird 153.x only. The Experiment API depends on message-list internals, so each new ESR needs a tested release.
- In the compact table view the bubble is 15 px: the rounded-square shape is visible, the border is not drawn.
- The logos in the pack belong to their owners.

## Building your own pack

`create-vcf/create_vcf.py` turns a CSV and a folder of logos images into the vcf.
Needs Python 3 and Pillow.

1. Copy `create-vcf/domains_map.example.csv` to `domains_map.csv`.
2. Put the logo in `create-vcf/images-source/`, add a row:
   `domain,source_image,category`. Domain = exact sender domain from the
   From header; subdomains are separate rows. The contact name comes from
   the file name (`amazon_logo.png` -> Amazon).
3. `python3 create-vcf/create_vcf.py`: writes `images-reworked/`,
   `review.md` (check the images there) and the vcf in `release/`.

Logos are not cropped: padded to a square with the corner color, scaled to
108 px on a 128 px canvas. Too small means too much margin in the source.
CSV, logos and review are in `.gitignore`.

## License

MPL 2.0. Derived from [Auto Profile Picture](https://addons.thunderbird.net/thunderbird/addon/auto-profile-picture/) by Noam Schmitt; all online providers, the image cache and the contact-writing behavior were removed. See `LICENSE` and `extension/NOTICE.md`.
