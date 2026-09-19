// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The one correspondent whose avatar is displayed for a message.
export default class Author {
  constructor(author, mail) {
    this.author = author || "";
    this.mail = mail || "";
  }

  // Uses Thunderbird's own mailbox parser so quoted/encoded names match its UI.
  static async cst_fromAuthor(author) {
    if (!author) {
      return new Author("", "");
    }

    try {
      const parsed = await browser.messengerUtilities.parseMailboxString(author);
      const mail = parsed?.[0]?.email?.trim().toLowerCase() || "";
      return new Author(author, mail);
    } catch (error) {
      console.warn("Could not parse correspondent header", error);
      return new Author(author, "");
    }
  }

  cst_getEmail() {
    return this.mail;
  }

  cst_getAuthor() {
    return this.author;
  }

  // Two initials from the display name, else from the local part of the email.
  cst_getInitials() {
    const parsedName = this.author.split("<")[0].trim();
    const words = parsedName.match(/[\p{L}\p{N}]+/gu) || [];
    if (this.author.includes("<") && words.length > 0) {
      return words
        .slice(0, 2)
        .map((word) => Array.from(word)[0])
        .join("")
        .toUpperCase();
    }

    const localPart = this.mail.split("@")[0] || "";
    const segments = localPart.split(/[._-]+/).filter(Boolean);
    const letters = segments
      .slice(0, 2)
      .map((segment) => Array.from(segment)[0])
      .filter(Boolean)
      .join("");

    if (letters) {
      return letters.toUpperCase();
    }

    const fallback = Array.from(localPart || parsedName || "?")[0];
    return fallback ? fallback.toUpperCase() : "?";
  }
}
