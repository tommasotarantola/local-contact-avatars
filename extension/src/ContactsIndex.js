// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const SAFE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
]);

// In-memory index of local contacts: email -> contacts, domain -> contacts.
// Built from the address books only; no search API, cache or network access.
export default class ContactsIndex {
  constructor() {
    this.emailToContactIds = new Map();     // lower-case email -> [contactId]
    this.domainToContactIds = new Map();    // domain of a Domain Contact -> [contactId]
    this.localPhotoContactIds = new Set();  // contacts whose PHOTO is embedded or file:
    this.photoDataUrls = new Map();         // contactId -> Promise<data URL or null>
    this.generation = 0;                    // bumped on rebuild, part of the revision key
  }

  // Trims, strips "mailto:", lower-cases.
  cst_utl_normalizeEmail(value) {
    if (typeof value !== "string") {
      return "";
    }

    let email = value.trim();
    if (/^mailto:/i.test(email)) {
      email = email.slice(7);
    }
    return email.trim().toLowerCase();
  }

  // RFC 6350 3.4 text unescaping.
  cst_utl_unescapeVCardText(value) {
    return value
      .replace(/\\n/gi, "\n")
      .replace(/\\,/g, ",")
      .replace(/\\;/g, ";")
      .replace(/\\\\/g, "\\");
  }

  // Splits a comma-separated vCard value, honoring backslash escapes.
  cst_utl_splitVCardList(value) {
    const items = [];
    let item = "";
    let escaped = false;

    for (const character of value) {
      if (escaped) {
        item += character;
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === ",") {
        items.push(item.trim());
        item = "";
      } else {
        item += character;
      }
    }
    items.push(item.trim());
    return items;
  }

  // Index of the first ":" outside quotes, i.e. the name/value separator.
  cst_utl_findValueSeparator(line) {
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
      if (line[index] === '"' && line[index - 1] !== "\\") {
        quoted = !quoted;
      } else if (line[index] === ":" && !quoted) {
        return index;
      }
    }
    return -1;
  }

  // Unfolds the raw vCard and returns [{ declaration, name, value }] per line.
  cst_utl_extractVCardEntries(contact) {
    const entries = [];
    const vCard = contact?.properties?.vCard;
    if (typeof vCard !== "string") {
      return entries;
    }

    const unfolded = vCard.replace(/\r?\n[ \t]/g, "");
    for (const line of unfolded.split(/\r?\n/)) {
      const separator = this.cst_utl_findValueSeparator(line);
      if (separator < 0) {
        continue;
      }

      const declaration = line.slice(0, separator);
      entries.push({
        declaration,
        name: declaration
          .split(";", 1)[0]
          .split(".")
          .pop()
          .toUpperCase(),
        value: line.slice(separator + 1).trim(),
      });
    }
    return entries;
  }

  // All EMAIL values of a contact, normalized and deduplicated.
  cst_utl_extractEmails(contact, entries) {
    const emails = new Set();

    for (const entry of entries) {
      if (entry.name !== "EMAIL") {
        continue;
      }
      const normalized = this.cst_utl_normalizeEmail(
        this.cst_utl_unescapeVCardText(entry.value),
      );
      if (normalized) {
        emails.add(normalized);
      }
    }

    // Legacy properties are a fallback for old local cards without a vCard.
    if (emails.size === 0) {
      for (const propertyName of ["PrimaryEmail", "SecondEmail"]) {
        const normalized = this.cst_utl_normalizeEmail(
          contact?.properties?.[propertyName],
        );
        if (normalized) {
          emails.add(normalized);
        }
      }
    }

    return [...emails];
  }

  // Lower-case host name with at least two valid labels, or "".
  cst_utl_normalizeDomain(value) {
    if (typeof value !== "string") {
      return "";
    }

    const candidate = value.trim().toLowerCase().replace(/\.$/, "");
    if (!candidate || /[\s\/:@]/.test(candidate)) {
      return "";
    }

    try {
      const domain = new URL(`https://${candidate}/`).hostname.toLowerCase();
      const labels = domain.split(".");
      if (
        domain.length > 253 ||
        labels.length < 2 ||
        labels.some(
          (label) =>
            !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
        )
      ) {
        return "";
      }
      return domain;
    } catch (_error) {
      return "";
    }
  }

  // Domain of a Domain Contact: KIND:org, CATEGORIES domain-contact, one https root URL.
  cst_utl_extractDomainContactDomain(entries) {
    const kind = entries.find((entry) => entry.name === "KIND")?.value;
    if (kind?.toLowerCase() !== "org") {
      return "";
    }

    const categories = entries
      .filter((entry) => entry.name === "CATEGORIES")
      .flatMap((entry) => this.cst_utl_splitVCardList(entry.value))
      .map((value) => value.toLowerCase());
    if (!categories.includes("domain-contact")) {
      return "";
    }

    const urls = entries.filter((entry) => entry.name === "URL");
    if (urls.length !== 1) {
      return "";
    }

    try {
      const url = new URL(urls[0].value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      ) {
        return "";
      }
      return this.cst_utl_normalizeDomain(url.hostname);
    } catch (_error) {
      return "";
    }
  }

  // True only for embedded or file: photos: getPhoto() would fetch an https PHOTO.
  cst_utl_hasLocalPhoto(entries) {
    for (const entry of entries) {
      if (entry.name !== "PHOTO") {
        continue;
      }

      const value = entry.value;
      // Thunderbird may escape the data-URL comma after importing a vCard.
      if (/^data:image\/(?:jpeg|png);base64\\?,/i.test(value)) {
        return true;
      }
      if (/^file:\/\//i.test(value)) {
        return true;
      }
      if (
        /;(?:ENCODING=(?:B|BASE64))(?:;|$)/i.test(entry.declaration) &&
        /^[A-Za-z0-9+/=]+$/.test(value)
      ) {
        return true;
      }
      return false;
    }

    return false;
  }

  // Rebuilds all maps from scratch; sorted iteration keeps matches deterministic.
  async cst_build() {
    const nextEmailToContactIds = new Map();
    const nextDomainToContactIds = new Map();
    const nextLocalPhotoContactIds = new Set();
    const addressBooks = await browser.addressBooks.list(true);
    addressBooks.sort((left, right) => left.id.localeCompare(right.id));

    for (const addressBook of addressBooks) {
      const contacts = [...(addressBook.contacts || [])];
      contacts.sort((left, right) => left.id.localeCompare(right.id));

      for (const contact of contacts) {
        const entries = this.cst_utl_extractVCardEntries(contact);
        if (this.cst_utl_hasLocalPhoto(entries)) {
          nextLocalPhotoContactIds.add(contact.id);
        }
        for (const email of this.cst_utl_extractEmails(contact, entries)) {
          if (!nextEmailToContactIds.has(email)) {
            nextEmailToContactIds.set(email, []);
          }
          nextEmailToContactIds.get(email).push(contact.id);
        }

        const domain = this.cst_utl_extractDomainContactDomain(entries);
        if (domain) {
          if (!nextDomainToContactIds.has(domain)) {
            nextDomainToContactIds.set(domain, []);
          }
          nextDomainToContactIds.get(domain).push(contact.id);
        }
      }
    }

    this.emailToContactIds = nextEmailToContactIds;
    this.domainToContactIds = nextDomainToContactIds;
    this.localPhotoContactIds = nextLocalPhotoContactIds;
    this.photoDataUrls.clear();
    this.generation++;
  }

  // Reads a photo File into a data URL; only PNG and JPEG are accepted.
  async cst_utl_fileToDataUrl(file) {
    if (!SAFE_IMAGE_TYPES.has(file.type.toLowerCase())) {
      console.warn("Ignored unsupported contact photo type", file.type);
      return null;
    }

    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onerror = () => resolve(null);
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    });
  }

  // Cached per contact until the next rebuild.
  async cst_utl_getPhotoDataUrl(contactId) {
    if (!this.photoDataUrls.has(contactId)) {
      const photoPromise = browser.contacts
        .getPhoto(contactId)
        .then((file) => (file ? this.cst_utl_fileToDataUrl(file) : null))
        .catch((error) => {
          console.warn("Could not read contact photo", contactId, error);
          return null;
        });
      this.photoDataUrls.set(contactId, photoPromise);
    }
    return await this.photoDataUrls.get(contactId);
  }

  // First contact in the list with a readable local photo, or null.
  async cst_utl_getFirstAvatar(contactIds) {
    for (const contactId of contactIds) {
      if (!this.localPhotoContactIds.has(contactId)) {
        continue;
      }
      const value = await this.cst_utl_getPhotoDataUrl(contactId);
      if (value) {
        return {
          value,
          revision: `${this.generation}:${contactId}`,
        };
      }
    }
    return null;
  }

  // Exact email match first, then exact sender-domain match on Domain Contacts.
  async cst_getAvatar(email) {
    const normalized = this.cst_utl_normalizeEmail(email);
    const emailAvatar = await this.cst_utl_getFirstAvatar(
      this.emailToContactIds.get(normalized) || [],
    );
    if (emailAvatar) {
      return { ...emailAvatar, kind: "email" };
    }

    const at = normalized.lastIndexOf("@");
    if (at <= 0 || at === normalized.length - 1) {
      return null;
    }
    const domain = this.cst_utl_normalizeDomain(normalized.slice(at + 1));
    const domainAvatar = await this.cst_utl_getFirstAvatar(
      this.domainToContactIds.get(domain) || [],
    );
    return domainAvatar ? { ...domainAvatar, kind: "domain" } : null;
  }
}
