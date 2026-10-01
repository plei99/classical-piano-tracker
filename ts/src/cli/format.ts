/**
 * Human-oriented output blocks shared by the recommend and spotify commands.
 */
import {
  type PianistProfile,
  type TasteSummary,
  type TasteTrack,
  type ValidatedPianist,
  goFormatFixed,
} from '../recommend';
import type { RecentTrack } from '../spotify';
import { goAtoi, goFields, goTrimSpace, runeCount } from './gostr';
import { TabWriter } from './tabwriter';
import { utcDateTime } from './timefmt';

export const FALLBACK_OUTPUT_WIDTH = 100;
const MIN_OUTPUT_WIDTH = 40;

/** Where commands write. Process streams satisfy it, as do test buffers. */
export interface Out {
  write(chunk: string): unknown;
  /** Set on terminal streams; only then is `columns` trusted for wrapping. */
  isTTY?: boolean;
  columns?: number;
}

/**
 * Renders recent plays as a human-scannable block per track. Spotify reports
 * play times in UTC, and the Go build printed them in that zone.
 */
export function printRecentSpotifyTracks(out: Out, tracks: RecentTrack[]): void {
  tracks.forEach((track, idx) => {
    out.write(`${idx + 1}. ${track.name}\n`);
    out.write(`   Artists: ${track.artists.map((artist) => artist.name).join(', ')}\n`);
    if (goTrimSpace(track.albumName) !== '') {
      out.write(`   Album:   ${track.albumName}\n`);
    }
    out.write(`   Played:  ${utcDateTime(track.playedAt)}\n`);
    if (idx < tracks.length - 1) {
      out.write('\n');
    }
  });
}

/** Renders deterministic pianist scores as a compact aligned table. */
export function printFavoritePianists(out: Out, profiles: PianistProfile[]): void {
  const table = new TabWriter();
  table.write('#\tPianist\tScore\tAvg Stars\tRated Tracks\tTotal Plays\n');
  profiles.forEach((profile, idx) => {
    table.write(
      `${idx + 1}\t${profile.name}\t${goFormatFixed(profile.favoriteScore, 2)}\t${goFormatFixed(profile.averageStars, 2)}\t` +
        `${profile.ratedTrackCount}\t${profile.totalPlayCount}\n`,
    );
  });
  out.write(table.flush());
}

/**
 * Renders the profile snapshot sent to the LLM, leaving out the internal
 * discovery-guidance prompt text.
 */
export function printTasteProfile(out: Out, summary: TasteSummary): void {
  const width = outputWidth(out);
  out.write(
    `Tracks: ${summary.totalTracks}\nRatings: ${summary.totalRatings}\nComments: ${summary.commentCount}\n` +
      `Known Pianists: ${summary.knownPianists.length}\n\n`,
  );

  out.write('Favorite Pianists\n');
  if (summary.favoritePianists.length === 0) {
    out.write('  none\n');
  } else {
    const table = new TabWriter();
    table.write('  #\tPianist\tAvg Stars\tRated Tracks\tTotal Plays\n');
    summary.favoritePianists.forEach((pianist, idx) => {
      table.write(
        `  ${idx + 1}\t${pianist.name}\t${goFormatFixed(pianist.averageStars, 2)}\t${pianist.ratedTrackCount}\t` +
          `${pianist.totalPlayCount}\n`,
      );
    });
    out.write(table.flush());
  }

  out.write('\n');
  printTasteTracks(out, 'Loved Tracks', summary.lovedTracks, width);
  out.write('\n');
  printTasteTracks(out, 'Disliked Tracks', summary.dislikedTracks, width);
  out.write('\n');
  printTasteTracks(out, 'Commented Tracks', summary.commentedTracks, width);
  out.write('\n');
  printWrappedField(out, 'Known Pianists: ', '                ', summary.knownPianists.join(', '), width);
}

function printTasteTracks(out: Out, heading: string, tracks: TasteTrack[], width: number): void {
  out.write(`${heading}\n`);
  if (tracks.length === 0) {
    out.write('  none\n');
    return;
  }

  const next = '              ';
  tracks.forEach((track, idx) => {
    out.write(`  ${idx + 1}. [${track.trackId}] ${track.trackName}\n`);
    printWrappedField(out, '     Artists: ', next, track.artists.join(', '), width);
    if (goTrimSpace(track.matchedArtist) !== '') {
      out.write(`     Matched: ${track.matchedArtist}\n`);
    }
    if (goTrimSpace(track.albumName) !== '') {
      printWrappedField(out, '     Album:   ', next, track.albumName, width);
    }
    out.write(`     Stars:   ${track.stars}/5\n`);
    out.write(`     Plays:   ${track.playCount}\n`);
    if (goTrimSpace(track.opinion) !== '') {
      printWrappedField(out, '     Opinion: ', next, track.opinion, width);
    }
    if (idx < tracks.length - 1) {
      out.write('\n');
    }
  });
}

/**
 * Renders the validated subset of LLM suggestions after the Spotify catalog
 * lookup has attached IDs and genres.
 */
export function printValidatedPianists(out: Out, summary: string, pianists: ValidatedPianist[]): void {
  const width = outputWidth(out);
  const next = '               ';
  printWrappedField(out, 'Summary: ', '', summary, width);
  out.write('\n');
  pianists.forEach((pianist, idx) => {
    out.write(`${idx + 1}. ${pianist.spotifyName}\n`);
    out.write(`   Spotify ID: ${pianist.spotifyId}\n`);
    if (pianist.genres.length > 0) {
      printWrappedField(out, '   Genres:     ', next, pianist.genres.join(', '), width);
    }
    if (pianist.similarTo.length > 0) {
      printWrappedField(out, '   Similar to: ', next, pianist.similarTo.join(', '), width);
    }
    printWrappedField(out, '   Why:        ', next, pianist.whyFit, width);
    if (goTrimSpace(pianist.confidence) !== '') {
      out.write(`   Confidence: ${pianist.confidence}\n`);
    }
    if (idx < pianists.length - 1) {
      out.write('\n');
    }
  });
}

/**
 * The wrap width: the terminal's width when writing to one, else $COLUMNS,
 * else 100. Widths under 40 are ignored as implausible.
 */
export function outputWidth(out: Out): number {
  if (out.isTTY === true && typeof out.columns === 'number' && out.columns >= MIN_OUTPUT_WIDTH) {
    return out.columns;
  }
  const columns = goAtoi(goTrimSpace(process.env['COLUMNS'] ?? ''));
  if (columns !== null && columns >= MIN_OUTPUT_WIDTH) {
    return columns;
  }
  return FALLBACK_OUTPUT_WIDTH;
}

/**
 * Word-wraps `value` (whitespace collapsed) to `width` runes, starting with
 * `firstPrefix` and continuing with `nextPrefix`. Lines always leave room for
 * at least 20 runes of text, and a single long word is never split.
 */
export function printWrappedField(
  out: Out,
  firstPrefix: string,
  nextPrefix: string,
  value: string,
  width: number,
): void {
  const words = goFields(value);
  if (words.length === 0) {
    out.write(`${firstPrefix.replace(/ +$/, '')}\n`);
    return;
  }

  const availableAfter = (prefix: string) => Math.max(20, width - runeCount(prefix));
  let linePrefix = firstPrefix;
  let available = availableAfter(linePrefix);
  let current = '';
  let currentLength = 0;

  for (const word of words) {
    const wordLength = runeCount(word);
    if (current === '') {
      current = word;
      currentLength = wordLength;
      continue;
    }
    if (currentLength + 1 + wordLength <= available) {
      current += ` ${word}`;
      currentLength += 1 + wordLength;
      continue;
    }

    out.write(`${linePrefix}${current}\n`);
    linePrefix = nextPrefix;
    available = availableAfter(linePrefix);
    current = word;
    currentLength = wordLength;
  }

  if (current !== '') {
    out.write(`${linePrefix}${current}\n`);
  }
}
