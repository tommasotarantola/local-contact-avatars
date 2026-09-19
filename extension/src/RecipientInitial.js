// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Fallback bubble shown when no contact photo matches: initials on a color.
export default class RecipientInitial {
  // Stable pastel color derived from a hash of the email, one per theme.
  static cst_getColor(identifier) {
    let hash = 0;
    for (let index = 0; index < identifier.length; index++) {
      hash = (hash << 5) - hash + identifier.charCodeAt(index);
      hash |= 0;
    }

    const absoluteHash = Math.abs(hash);
    const hue = (absoluteHash % 36000) / 100;
    const chroma = 0.05 + (absoluteHash % 5) / 1000;
    const lightnessLight = 0.8 + (absoluteHash % 10) / 100;
    const lightnessDark = 0.4 + (absoluteHash % 10) / 100;

    const light = `oklch(${lightnessLight.toFixed(2)} ${chroma.toFixed(3)} ${hue.toFixed(2)})`;
    const dark = `oklch(${lightnessDark.toFixed(2)} ${chroma.toFixed(3)} ${hue.toFixed(2)})`;
    return `light-dark(${light}, ${dark})`;
  }

  // Returns { initials, color } for the given Author.
  static cst_build(author) {
    const identifier = author.cst_getEmail() || author.cst_getAuthor() || "";
    return {
      initials: author.cst_getInitials(),
      color: RecipientInitial.cst_getColor(identifier),
    };
  }
}
