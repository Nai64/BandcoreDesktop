import type { Session } from 'electron';
import type { PlayerTrack, TralbumType, CollectionItem, DownloadFormat, FeedStory, SearchResultItem } from '../shared/types';

// mirrors res strat used by bandcamp player ext: hit cred tralbum endpoints to obtain full tracklist (w/ direct stream urls) for release. this is what lets player advance thru album or collection w/out scraping per track dom.

interface TralbumQuery {
    bandId?: string;
    tralbumId: string;
    tralbumType: TralbumType;
    trackId?: string;
}

const STREAM_PREFERENCE = ['mp3-128', 'mp3-v0', 'mp3-320'];

// how long fetched tracklist / track -> album map stays fresh. mirrors ext tralbum cache ttl ms so repeated traps of same release (or player's per track fallback) never rehit network.
const CACHE_TTL_MS = 15 * 60 * 1000;

function toId(value: unknown): string {
    if (value === null || value === undefined) return '';
    const match = String(value).match(/\d+/);
    return match ? match[0] : '';
}

// bcbits thumbs come in fixed size presets (the suffix number): _7 is ~150px,
// _9 ~210px - too small for the ~230px grid cards on hi-dpi screens. the
// collection and album views use _10 (~1200px); search art should too.
function hiResArt(url: string): string {
    const u = String(url || '').trim();
    return /\/img\/[^"'\s]*_\d+\.jpg$/i.test(u) ? u.replace(/_\d+\.jpg$/, '_10.jpg') : u;
}

function pickStream(file: any): string {
    if (typeof file === 'string') return file.trim();
    if (!file || typeof file !== 'object') return '';
    for (const key of STREAM_PREFERENCE) {
        if (typeof file[key] === 'string' && file[key]) return file[key];
    }
    const first = Object.values(file).find((v) => typeof v === 'string' && v);
    return (first as string) || '';
}

export class BandcampApi {
    // main proc owns content view session; we reuse it so reqs carry fan login cookies (priv streams resolve correctly).
    constructor(private readonly getSession: () => Session | null) {}

    /** set by main: called whenever bandcamp answers HTTP 429 (drives the user-facing notice). */
    on429?: () => void;
    private notify429(status: number): void {
        if (status === 429) { try { this.on429?.(); } catch { /* notifier failed */ } }
    }

    // cache full tracklists by `${type}:${tralbumId}` and track -> album map by track id. both expire after cache ttl ms.
    private readonly tralbumCache = new Map<string, { tracks: PlayerTrack[]; at: number }>();
    private readonly albumOfTrack = new Map<string, { albumId: string; bandId: string; at: number }>();
    // release year by `${type}:${id}` (bandcamp's collection api omits release dates, so we read them from the tralbum endpoint on demand)
    private readonly yearCache = new Map<string, number>();

    // pull the release *year* out of a tralbum payload (string date or unix ts)
    private extractYear(data: any): number {
        if (!data || typeof data !== 'object') return 0;
        const cur = data.current || {};
        const raw = data.release_date ?? cur.release_date ?? data.publish_date ?? cur.publish_date;
        if (raw == null || raw === '') return 0;
        let d: Date | null = null;
        if (typeof raw === 'number') d = new Date(raw > 1e12 ? raw : raw * 1000);
        else { const t = Date.parse(String(raw)); if (!isNaN(t)) d = new Date(t); }
        const y = d ? d.getFullYear() : Number(String(raw).match(/\b(19|20)\d{2}\b/)?.[0] || 0);
        return y > 1900 && y < 3000 ? y : 0;
    }

    /** release year for a (type,id), fetched (and cached) from the tralbum endpoint. 0 if unknown. */
    async fetchReleaseYear(q: TralbumQuery): Promise<number> {
        const id = toId(q.tralbumId);
        if (!id) return 0;
        const key = `${q.tralbumType}:${id}`;
        if (this.yearCache.has(key)) return this.yearCache.get(key) as number;
        const types: TralbumType[] = q.tralbumType === 't' ? ['t', 'a'] : ['a', 't'];
        for (const type of types) {
            const data = await this.fetchRaw(type, id, q.bandId);
            if (!data) continue;
            const y = this.extractYear(data);
            this.yearCache.set(`${type}:${id}`, y);
            if (y) return y;
        }
        return this.yearCache.get(key) || 0;
    }

    /**
     * release details for one collection/feed item: genre tags, tracklist
     * (title+duration), release year & about text. drives the collection's search
     * index / list view and the feed's expanded cards. status-aware so the bulk
     * index builder can back off on 429 instead of silently losing items.
     */
    async fetchSearchIndex(q: TralbumQuery, interactive = false): Promise<
        { ok: true; tags: string[]; tracks: { title: string; duration: number }[]; year: number; about: string }
        | { ok: false; retryable: boolean }
    > {
        const id = toId(q.tralbumId);
        if (!id) return { ok: false, retryable: false };
        if (interactive) this.noteInteractive();
        const types: TralbumType[] = q.tralbumType === 't' ? ['t', 'a'] : ['a', 't'];
        let sawData = false;
        for (const type of types) {
            for (const url of this.attemptUrls(type, id, q.bandId)) {
                let { data, status } = await this.fetchRawFromStatus(url);
                // a user's click retries through a 429 (the crawler yields to us);
                // the bulk crawler instead returns retryable & backs off itself
                if (status === 429 && interactive) {
                    for (let attempt = 0; attempt < 3 && status === 429; attempt++) {
                        await new Promise((res) => setTimeout(res, 800 * Math.pow(2, attempt)));
                        ({ data, status } = await this.fetchRawFromStatus(url));
                    }
                }
                if (status === 429) return { ok: false, retryable: true };
                if (!data) continue;
                sawData = true;
                const tags = (Array.isArray(data.tags) ? data.tags : [])
                    .map((t: any) => String((t && (t.name || t.norm_name)) || '').trim())
                    .filter(Boolean);
                const rows: any[] = Array.isArray(data.trackinfo) ? data.trackinfo : Array.isArray(data.tracks) ? data.tracks : [];
                if (!tags.length && !rows.length) continue; // thin payload; try the next endpoint
                const year = this.extractYear(data);
                if (year) this.yearCache.set(`${q.tralbumType}:${id}`, year);
                return {
                    ok: true,
                    tags,
                    tracks: rows.map((t: any) => ({
                        title: String((t && t.title) || '').trim(),
                        duration: Math.max(0, Math.floor(Number(t && t.duration) || 0)),
                    })).filter((t) => t.title),
                    year,
                    about: String(data.about || (data.current && data.current.about) || '').trim(),
                };
            }
        }
        // real payloads but no tags/tracks anywhere: cache the emptiness (not retryable)
        if (sawData) return { ok: true, tags: [], tracks: [], year: 0, about: '' };
        return { ok: false, retryable: false };
    }

    /** seed the year cache (e.g. from a persisted store) so we don't refetch across sessions. */
    primeYear(type: TralbumType, id: string, year: number): void {
        if (id && year) this.yearCache.set(`${type}:${toId(id)}`, year);
    }
    getReleaseYear(type: TralbumType, id: string): number {
        return this.yearCache.get(`${type}:${toId(id)}`) || 0;
    }

    private cacheGet(key: string): PlayerTrack[] | null {
        const entry = this.tralbumCache.get(key);
        if (!entry) return null;
        if (Date.now() - entry.at > CACHE_TTL_MS) {
            this.tralbumCache.delete(key);
            return null;
        }
        return entry.tracks;
    }

    private attemptUrls(type: TralbumType, tralbumId: string, bandId?: string): string[] {
        const mobile = new URL('https://bandcamp.com/api/mobile/24/tralbum_details');
        const info = new URL('https://bandcamp.com/api/tralbum/2/info');
        for (const u of [mobile, info]) {
            if (bandId) u.searchParams.set('band_id', bandId);
            u.searchParams.set('tralbum_id', tralbumId);
            u.searchParams.set('tralbum_type', type);
        }
        // web (info) endpoint first: its `artist` is the release's own artist (e.g. a
        // side-project on a label's page), whereas mobile's tralbum_artist is the band
        // - using mobile first showed the band name instead of the release artist.
        return [info.toString(), mobile.toString()];
    }

    /** GET one endpoint & return {data,status} so bulk callers can react to 429s. */
    private async fetchRawFromStatus(url: string): Promise<{ data: any | null; status: number }> {
        const session = this.getSession();
        if (!session) return { data: null, status: 0 };
        try {
            const res = await session.fetch(url, { credentials: 'include' } as any);
            if (!res.ok) { this.notify429(res.status); return { data: null, status: res.status }; }
            const data: any = await res.json();
            if (!data || typeof data !== 'object') return { data: null, status: res.status };
            // bandcamp returns 200 with {error:true,error_message:...} for bad/retired
            // endpoints (tralbum/2/info now answers "bad function"). treating that as
            // data poisoned every fallback: track→album lookups died, so collection
            // track items played with the page/band artist instead of the release's.
            if (data.error) return { data: null, status: res.status };
            return { data, status: res.status };
        } catch {
            return { data: null, status: 0 };
        }
    }

    // user-initiated fetches note themselves here; the background index crawler
    // yields while this is fresh so interactive actions (opening a tracklist,
    // paging the feed) never lose the 429 budget to the crawl.
    private lastInteractiveAt = 0;
    noteInteractive(): void { this.lastInteractiveAt = Date.now(); }
    interactiveIdleMs(): number { return Date.now() - this.lastInteractiveAt; }

    /**
     * GET one endpoint & return its json object (or null). used by the
     * user-initiated paths, so it marks interactive activity & retries 429s
     * with a short backoff instead of failing the user's click.
     */
    private async fetchRawFrom(url: string): Promise<any | null> {
        this.noteInteractive();
        for (let attempt = 0; attempt < 3; attempt++) {
            const { data, status } = await this.fetchRawFromStatus(url);
            if (data) return data;
            if (status !== 429) return null;
            await new Promise((res) => setTimeout(res, 800 * Math.pow(2, attempt)));
        }
        return null;
    }

    /** fetch raw tralbum payload for single (type, id) used to read parent album id of track before fetching full album. */
    private async fetchRaw(type: TralbumType, tralbumId: string, bandId?: string): Promise<any | null> {
        if (!tralbumId) return null;
        for (const url of this.attemptUrls(type, tralbumId, bandId)) {
            const data = await this.fetchRawFrom(url);
            if (data) return data;
        }
        return null;
    }

    /** fetch & norm full tracklist for release (cached). */
    async fetchTralbum(q: TralbumQuery): Promise<PlayerTrack[]> {
        if (!q.tralbumId) return [];
        const primaryKey = `${q.tralbumType}:${q.tralbumId}`;
        const cached = this.cacheGet(primaryKey);
        if (cached) return cached;

        const types: TralbumType[] = q.tralbumType === 't' ? ['t', 'a'] : ['a', 't'];
        for (const type of types) {
            // try EACH endpoint (web then mobile) and use the first that yields
            // tracks. going through fetchRaw returned the first *object* the web
            // endpoint gave - if that was a trackless/error payload, the mobile
            // endpoint was never tried and the tracklist came back empty.
            for (const url of this.attemptUrls(type, q.tralbumId, q.bandId)) {
                const data = await this.fetchRawFrom(url);
                if (!data) continue;
                const tracks = this.normalize(data, { ...q, tralbumType: type });
                if (!tracks.length) continue;
                const at = Date.now();
                this.tralbumCache.set(primaryKey, { tracks, at });
                // also key by album id actually returned so track id lookup and later album id lookup share 1 cache entry.
                const realId = toId((data && (data.id ?? data.tralbum_id)) || q.tralbumId);
                if (realId) this.tralbumCache.set(`${type}:${realId}`, { tracks, at });
                // cache the release year while we have the payload
                const yr = this.extractYear(data);
                this.yearCache.set(primaryKey, yr);
                if (realId) this.yearCache.set(`${type}:${realId}`, yr);
                return tracks;
            }
        }
        return [];
    }

    /** resolve single missing stream url for queued track. */
    async resolveStream(q: TralbumQuery): Promise<PlayerTrack | null> {
        const tracks = await this.fetchTralbum(q);
        if (!tracks.length) return null;
        if (q.trackId) {
            const match = tracks.find((t) => t.id === toId(q.trackId));
            if (match) return match;
        }
        return tracks[0];
    }

    /**
     * build full album q from just track id. this is what makes collection, feed, discover and fan collection playlist surfaces play clicked release in full none of them expose tracklist in page so we look track up, find parent album, and fetch whole album.
     */
    async resolveQueueForTrack(
        trackId: string,
        bandId?: string
    ): Promise<{ tracks: PlayerTrack[]; activeIndex: number }> {
        const tId = toId(trackId);
        if (!tId) return { tracks: [], activeIndex: 0 };

        // reuse known track -> album map so retrap of same track skips discovery fetch entirely.
        const mapped = this.albumOfTrack.get(tId);
        if (mapped && Date.now() - mapped.at <= CACHE_TTL_MS) {
            const tracks = await this.fetchTralbum({
                tralbumId: mapped.albumId,
                tralbumType: 'a',
                bandId: mapped.bandId || bandId,
            });
            if (tracks.length) {
                const idx = tracks.findIndex((t) => t.id === tId);
                return { tracks, activeIndex: idx === -1 ? 0 : idx };
            }
        }

        const trackData = await this.fetchRaw('t', tId, bandId);
        const albumId = toId(trackData?.album_id ?? trackData?.current?.album_id ?? trackData?.album?.id);
        const resolvedBand = toId(
            trackData?.band_id ?? trackData?.current?.band_id ?? trackData?.selling_band_id ?? bandId
        );

        if (albumId) {
            this.albumOfTrack.set(tId, { albumId, bandId: resolvedBand, at: Date.now() });
            const tracks = await this.fetchTralbum({ tralbumId: albumId, tralbumType: 'a', bandId: resolvedBand });
            if (tracks.length) {
                const idx = tracks.findIndex((t) => t.id === tId);
                return { tracks, activeIndex: idx === -1 ? 0 : idx };
            }
        }

        // standalone track (no album or album fetch failed): q it alone but w/ proper metadata + real stream url.
        const single = this.normalize(trackData, { tralbumId: tId, tralbumType: 't', bandId: resolvedBand });
        return { tracks: single, activeIndex: 0 };
    }

    /**
     * resolve the tracklist for a bandcamp release/track *page url* (used by
     * add-to-queue on links & release pages). reads the page's embedded TralbumData
     * blob (data-tralbum on modern pages) so we get real stream urls without knowing
     * the tralbum id up front.
     */
    async fetchTracksFromUrl(pageUrl: string): Promise<PlayerTrack[]> {
        const session = this.getSession();
        if (!session || !pageUrl) return [];
        let html = '';
        try {
            const r = await session.fetch(pageUrl, { credentials: 'include' } as any);
            if (!r.ok) return [];
            html = await r.text();
        } catch {
            return [];
        }
        let blob: any = null;
        const m = html.match(/data-tralbum="([^"]+)"/);
        if (m) {
            try { blob = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')); } catch { /* try next */ }
        }
        if (!blob) {
            const m2 = html.match(/data-tralbum='([^']+)'/);
            if (m2) { try { blob = JSON.parse(m2[1]); } catch { /* give up */ } }
        }
        if (!blob) return [];
        const type: TralbumType = (blob.item_type === 'track' || blob.tralbum_type === 't') ? 't' : 'a';
        return this.normalize(blob, {
            tralbumId: toId(blob.id ?? blob.tralbum_id),
            tralbumType: type,
            bandId: toId(blob.band_id ?? blob.selling_band_id),
        });
    }

    /** resolve a bandcamp page url for a track/release that shipped without one (e.g. homepage playlist rows) so the player's title/artist links work. */
    async resolvePageUrl(q: { trackId?: string; bandId?: string; tralbumId?: string; tralbumType?: TralbumType }): Promise<string> {
        const bandId = q.bandId;
        const tId = toId(q.trackId);
        if (tId) {
            const d = await this.fetchRaw('t', tId, bandId);
            const u = (d?.url || d?.bandcamp_url || d?.current?.bandcamp_url || '').toString();
            if (u) return u;
        }
        const alb = toId(q.tralbumId);
        if (alb) {
            const type: TralbumType = q.tralbumType === 't' ? 't' : 'a';
            const d = await this.fetchRaw(type, alb, bandId);
            const u = (d?.url || d?.bandcamp_url || d?.current?.bandcamp_url || '').toString();
            if (u) return u;
        }
        return '';
    }

    private normalize(data: any, q: TralbumQuery): PlayerTrack[] {
        if (!data || typeof data !== 'object') return [];

        const current = data.current || {};
        const bandId = toId(data.band_id ?? data.selling_band_id ?? current.band_id ?? current.selling_band_id ?? q.bandId);
        const tralbumId = toId(data.id ?? data.tralbum_id ?? q.tralbumId);
        // page blobs spell item_type "track"/"album", the apis use "t"/"a"
        const rawType = String(data.item_type || data.tralbum_type || q.tralbumType || '');
        const tralbumType: TralbumType = (rawType === 't' || rawType === 'track') ? 't' : 'a';

        // prefer the release's own artist (current.artist / artist) over the band /
        // tralbum_artist so a side-project or various-artists release shows its real
        // artist, not the page/label name. tralbum_artist/band.name are fallbacks for
        // the mobile endpoint shape.
        const artist = (
            current.artist || data.artist || data.tralbum_artist ||
            data.band_name || (data.band && data.band.name) || 'Bandcamp'
        ).toString().trim();
        const album = (data.album_title || current.title || data.title || '').toString().trim();
        const artId = toId(data.art_id ?? current.art_id);
        const art = artId ? `https://f4.bcbits.com/img/a${artId}_10.jpg` : '';
        const pageUrl = (data.url || current.bandcamp_url || data.bandcamp_url || '').toString();

        const rawTracks: any[] = Array.isArray(data.trackinfo)
            ? data.trackinfo
            : Array.isArray(data.tracks)
            ? data.tracks
            : [];

        const tracks: PlayerTrack[] = rawTracks
            .map((t: any) => {
                const src = pickStream(t.file || t.streaming_url || t.mp3_url);
                const id = toId(t.track_id ?? t.id);
                const trkArtist = (t.artist || t.band_name || artist).toString().trim();
                let title = (t.title || current.title || 'Unknown Track').toString().trim();
                // VA compilations ship titles already composed as "artist - title"
                // while also carrying the artist separately (the player and the
                // tracklists render both lines) - drop the duplicated prefix here
                // so every surface gets the clean title.
                if (trkArtist) {
                    const esc = trkArtist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const m = title.match(new RegExp('^' + esc + '\\s*[-–—]\\s+'));
                    if (m) title = title.slice(m[0].length).trim() || title;
                }
                return {
                    id,
                    title,
                    artist: trkArtist,
                    album,
                    art,
                    src,
                    duration: Math.max(0, Math.floor(Number(t.duration) || 0)),
                    url: pageUrl,
                    bandId,
                    tralbumId,
                    tralbumType,
                } as PlayerTrack;
            })
            .filter((t) => t.src);

        return tracks;
    }

    // fan collection (for custom sortable collection view)

    /** norm 1 fancollection item (same shape as page item cache). */
    private normalizeCollectionItem(it: any, redownloadUrls: Record<string, string>): CollectionItem {
        const type: TralbumType = (it.item_type === 'track' || it.tralbum_type === 't') ? 't' : 'a';
        const artId = toId(it.item_art_id ?? it.art_id);
        const added = Date.parse(it.purchased || it.added || it.date_added || '') || 0;
        // release year: bandcamp's collection api usually omits it, so this is often 0
        // and gets filled in later by fetchReleaseYear (see collection:enrich-years).
        // deliberately NOT falling back to the added date - that made "sort by year"
        // behave like "sort by date added".
        const rel = it.release_date || it.releaseDate || '';
        const year = Number(String(rel).match(/\b(19|20)\d{2}\b/)?.[0]) || 0;
        // redownload key is sale_item_type + sale_item_id, e.g. c173525240
        const saleKey = (it.sale_item_type || '') + toId(it.sale_item_id);
        return {
            itemId: toId(it.item_id ?? it.tralbum_id),
            tralbumId: toId(it.tralbum_id ?? it.album_id ?? it.item_id),
            tralbumType: type,
            title: (it.item_title || it.album_title || it.title || '').toString().trim(),
            artist: (it.band_name || it.artist || '').toString().trim(),
            art: artId ? `https://f4.bcbits.com/img/a${artId}_9.jpg` : '',
            url: (it.item_url || '').toString(),
            bandId: toId(it.band_id ?? it.selling_band_id),
            addedAt: added,
            year,
            downloadUrl: (redownloadUrls[saleKey] || '').toString(),
        };
    }

    /**
     * fetch fan entire collection via fancollection api (page only embeds first ~20). resolves fan id + total count from cred collection summary endpoint then pages thru collection items.
     *
     * prev impl broke on any transient !ok (esp http 429) mid paginate, truncating collection to whatever it had (hence 580 / 1265 of 2780). now: big page size (fewer reqs = faster & less likely throttled) + per page retry w/ backoff so a single hiccup can't cut the run short. onprogress reports running count to view.
     */
    /**
     * stopAtKeys: keys ("<type><id>") already known to the caller. the collection
     * api pages newest-first, so hitting a known item means everything after it is
     * already cached - stop there. this is what makes Reload/startup an
     * incremental "check for new purchases" instead of a full re-scan.
     */
    async fetchCollection(
        maxItems = 20000,
        onProgress?: (added: CollectionItem[], soFar: number, total: number) => void,
        stopAtKeys?: Set<string>,
        kind: 'collection' | 'wishlist' = 'collection'
    ): Promise<CollectionItem[]> {
        const session = this.getSession();
        if (!session) return [];

        let fanId = '';
        let total = 0;
        try {
            const r = await session.fetch('https://bandcamp.com/api/fan/2/collection_summary', {
                credentials: 'include',
            } as any);
            if (r.ok) {
                const d: any = await r.json();
                fanId = toId(d?.fan_id ?? d?.collection_summary?.fan_id);
                // summary lists every owned tralbum keyed by <type><id>; its size is the real count to page toward
                const lookup = d?.collection_summary?.tralbum_lookup;
                if (kind === 'collection' && lookup && typeof lookup === 'object') total = Object.keys(lookup).length;
            }
        } catch {
            // fall thru
        }
        if (!fanId) return [];

        // pull one page w/ retry: only give up on a page after several failed attempts (backoff) so throttling can't silently truncate the collection
        const COUNT = 500;
        const fetchPage = async (token: string): Promise<any | null> => {
            for (let attempt = 0; attempt < 6; attempt++) {
                try {
                    const r = await session.fetch(`https://bandcamp.com/api/fancollection/1/${kind}_items`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ fan_id: Number(fanId), older_than_token: token, count: COUNT }),
                        credentials: 'include',
                    } as any);
                    if (r.ok) return await r.json();
                    this.notify429(r.status);
                    // 429 / 5xx: back off & retry rather than abandoning the whole collection
                    if (r.status !== 429 && r.status < 500) return null;
                } catch {
                    // network blip: retry
                }
                await new Promise((res) => setTimeout(res, 400 * Math.pow(2, attempt)));
            }
            return null;
        };

        const out: CollectionItem[] = [];
        const seen = new Set<string>();
        let token = `${Math.floor(Date.now() / 1000)}::a::`;
        const seenTokens = new Set<string>();
        for (let page = 0; page < 200 && out.length < maxItems; page++) {
            const data = await fetchPage(token);
            if (!data) break;
            const items: any[] = Array.isArray(data?.items) ? data.items : [];
            if (!items.length) break;
            // maps sale key -> download page url for owned items
            const redl: Record<string, string> = (data?.redownload_urls && typeof data.redownload_urls === 'object') ? data.redownload_urls : {};
            const added: CollectionItem[] = [];
            let hitKnown = false;
            for (const it of items) {
                const c = this.normalizeCollectionItem(it, redl);
                if (kind === 'wishlist') c.wish = true;
                const key = c.tralbumType + c.tralbumId;
                if (!c.tralbumId || seen.has(key)) continue;
                if (stopAtKeys && stopAtKeys.has(key)) { hitKnown = true; break; }
                seen.add(key);
                out.push(c);
                added.push(c);
            }
            if (hitKnown) {
                if (onProgress && added.length) onProgress(added, out.length, out.length);
                return out;
            }
            // hand each page to the caller as it arrives so the view can render
            // progressively instead of blocking on the whole (multi-request) fetch
            if (onProgress) onProgress(added, out.length, Math.max(total, out.length));
            const next = data?.last_token || '';
            // stop on no more, empty token, or a token that didn't advance (guards against a stuck cursor looping forever)
            if (!data?.more_available || !next || seenTokens.has(next)) break;
            seenTokens.add(next);
            token = next;
        }
        return out;
    }

    /** fetch a small binary (album cover) for the on-disk release cache. */
    async fetchBinary(url: string): Promise<Buffer | null> {
        const session = this.getSession();
        if (!session || !url || !url.startsWith('https://')) return null;
        try {
            const r = await session.fetch(url, { credentials: 'include' } as any);
            if (!r.ok) return null;
            return Buffer.from(await r.arrayBuffer());
        } catch {
            return null;
        }
    }

    /**
     * one page of a fan list (wishlist or owned collection) for the home
     * rail's load-more. same endpoint and normalization as fetchCollection,
     * but exposes the continuation token so the caller can page as the user
     * scrolls. token '' fetches the newest page.
     */
    async fetchWishlistPage(olderThan = '', kind: 'collection' | 'wishlist' = 'wishlist'): Promise<{ items: CollectionItem[]; lastToken: string; more: boolean }> {
        const session = this.getSession();
        if (!session) return { items: [], lastToken: olderThan, more: false };
        let fanId = '';
        try {
            const r = await session.fetch('https://bandcamp.com/api/fan/2/collection_summary', {
                credentials: 'include',
            } as any);
            if (r.ok) {
                const d: any = await r.json();
                fanId = toId(d?.fan_id ?? d?.collection_summary?.fan_id);
            }
        } catch {
            // fall thru
        }
        if (!fanId) return { items: [], lastToken: olderThan, more: false };
        // the api expects a time-based cursor for the first page ('' gets rejected)
        const startToken = olderThan || `${Math.floor(Date.now() / 1000)}::a::`;
        let data: any = null;
        for (let attempt = 0; attempt < 6; attempt++) {
            try {
                const r = await session.fetch(`https://bandcamp.com/api/fancollection/1/${kind}_items`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fan_id: Number(fanId), older_than_token: startToken, count: 500 }),
                    credentials: 'include',
                } as any);
                if (r.ok) { data = await r.json(); break; }
                this.notify429(r.status);
                if (r.status !== 429 && r.status < 500) return { items: [], lastToken: olderThan, more: false };
            } catch {
                // retry
            }
            await new Promise((res) => setTimeout(res, 400 * Math.pow(2, attempt)));
        }
        if (!data) return { items: [], lastToken: olderThan, more: false };
        const raw: any[] = Array.isArray(data?.items) ? data.items : [];
        const redl: Record<string, string> = (data?.redownload_urls && typeof data.redownload_urls === 'object') ? data.redownload_urls : {};
        const out: CollectionItem[] = [];
        const seen = new Set<string>();
        for (const it of raw) {
            const c = this.normalizeCollectionItem(it, redl);
            if (kind === 'wishlist') c.wish = true;
            const key = c.tralbumType + c.tralbumId;
            if (!c.tralbumId || seen.has(key)) continue;
            seen.add(key);
            out.push(c);
        }
        return { items: out, lastToken: String(data?.last_token || ''), more: !!(data?.more_available) && out.length > 0 };
    }

    // --- fan feed (custom feed view) -----------------------------------------

    private cachedFanId = '';

    /**
     * decode the fan id straight out of the identity cookie (no network).
     * the cookie is url-encoded `...\t{"id":12345,"h1":"...","ex":0}` - this
     * keeps fan resolution working even when the summary endpoint hiccups.
     */
    async fanIdFromCookie(): Promise<string> {
        try {
            const cs = await this.getSession()?.cookies.get({ url: 'https://bandcamp.com', name: 'identity' });
            const v = cs?.[0]?.value || '';
            const m = decodeURIComponent(v).match(/"id"\s*:\s*(\d+)/);
            if (m?.[1]) return m[1];
        } catch { /* fall through */ }
        return '';
    }

    /** resolve (and cache) the logged-in fan's id from the collection summary. */
    private async getFanId(): Promise<string> {
        if (this.cachedFanId) return this.cachedFanId;
        // cookie first: instant, and immune to summary-endpoint failures
        const fromCookie = await this.fanIdFromCookie();
        if (fromCookie) { this.cachedFanId = fromCookie; return fromCookie; }
        const session = this.getSession();
        if (!session) return '';
        try {
            const r = await session.fetch('https://bandcamp.com/api/fan/2/collection_summary', {
                credentials: 'include',
            } as any);
            if (r.ok) {
                const d: any = await r.json();
                this.cachedFanId = toId(d?.fan_id ?? d?.collection_summary?.fan_id);
            }
        } catch { /* stay '' */ }
        return this.cachedFanId;
    }

    private cachedFanUsername = '';
    /** the fan's bandcamp username (for the /<name>/feed page url). */
    private async getFanUsername(): Promise<string> {
        if (this.cachedFanUsername) return this.cachedFanUsername;
        const session = this.getSession();
        if (!session) return '';
        try {
            const r = await session.fetch('https://bandcamp.com/api/fan/2/collection_summary', { credentials: 'include' } as any);
            if (r.ok) {
                const d: any = await r.json();
                const direct = String(d?.username || d?.fan_username || d?.collection_summary?.username || '').trim();
                if (direct) { this.cachedFanUsername = direct; return direct; }
                const url = String(d?.url || d?.trackpipe_url || d?.collection_summary?.url || '');
                const m = url.match(/bandcamp\.com\/([^/?#]+)/i);
                if (m) { this.cachedFanUsername = m[1]; return m[1]; }
            }
        } catch { /* try the redirect below */ }
        // last resort: bandcamp redirects /feed to the logged-in fan's feed page
        try {
            const r = await session.fetch('https://bandcamp.com/feed', { credentials: 'include' } as any);
            const m = String((r as any).url || '').match(/bandcamp\.com\/([^/?#]+)\/feed/i);
            if (m) this.cachedFanUsername = m[1];
        } catch { /* unknown */ }
        return this.cachedFanUsername;
    }

    /**
     * bandcamp's dash feed is a stored SNAPSHOT that only regenerates when the
     * fan's feed page is actually visited - fan_dash_feed_updates just reads it.
     * without this poke the feed ended at whenever the user last opened
     * bandcamp's own feed page (newer releases simply weren't in the snapshot).
     */
    private async regenerateFeed(): Promise<void> {
        const session = this.getSession();
        if (!session) return;
        try {
            const name = await this.getFanUsername();
            const url = name ? `https://bandcamp.com/${encodeURIComponent(name)}/feed` : 'https://bandcamp.com/feed';
            const r = await session.fetch(url, { credentials: 'include' } as any);
            await r.text(); // consume - the page visit itself triggers regeneration
        } catch { /* snapshot stays stale; updates endpoint still works */ }
    }

        // --- email + password login ------------------------------------------------
    // mirrors the site's own login form: GET /login for session cookies +
    // the csrf meta, then POST /login_cb with the same fields its knockout
    // model sends ("user.name", "login.password", optional "login.twofactor").
    // the password is never stored - only the resulting session cookies live on.
    async loginWithPassword(
        user: string,
        pass: string,
        twoFactor = ''
    ): Promise<{ ok: boolean; fanId?: string; needTwoFactor?: boolean; error?: string }> {
        const session = this.getSession();
        if (!session) return { ok: false, error: 'no session' };
        const u = (user || '').trim();
        const p = pass || '';
        if (!u || !p) return { ok: false, error: 'enter email and password' };
        let csrf = '';
        try {
            const r = await session.fetch('https://bandcamp.com/login', { credentials: 'include' } as any);
            const html = await r.text();
            const m = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)/i)
                || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
            if (m) csrf = m[1];
        } catch { return { ok: false, error: 'could not reach the login page' }; }
        const body = new URLSearchParams();
        body.set('user.name', u);
        body.set('login.password', p);
        body.set('login.twofactor', twoFactor);
        body.set('login.twofactor_remember', twoFactor ? 'true' : '');
        let data: any = null;
        try {
            const r = await session.fetch('https://bandcamp.com/login_cb', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    // bandcamp's _cb endpoints only answer real xhr calls
                    'X-Requested-With': 'XMLHttpRequest',
                    ...(csrf ? { 'X-CSRF-TOKEN': csrf } : {}),
                },
                body: body.toString(),
                credentials: 'include',
            } as any);
            const text = await r.text();
            try { data = JSON.parse(text); }
            catch { return { ok: false, error: 'bandcamp rejected the login request' }; }
        } catch { return { ok: false, error: 'login request failed' }; }
        if (data?.ok) {
            this.cachedFanId = '';
            this.cachedFanUsername = '';
            const fanId = toId(data.fan_id) || await this.fanIdFromCookie();
            return { ok: true, fanId };
        }
        const errs: any[] = Array.isArray(data?.errors) ? data.errors : [];
        const has = (f: string, r?: string) => errs.some((e: any) => e?.field === f && (!r || e?.reason === r));
        if (has('login.twofactor')) return { ok: false, needTwoFactor: true };
        if (has('login.captcha')) return { ok: false, error: 'bandcamp wants a human check - log in once on the site inside the app, then you are set' };
        if (has('login.user', 'matchedManyUsers')) return { ok: false, error: 'several accounts share this login - pick one by logging in on the site' };
        if (has('login.user') || has('user.name')) return { ok: false, error: 'unknown username or email' };
        if (has('login.password')) return { ok: false, error: 'incorrect password' };
        // bot wall: a bare `error: true` (or a captcha flag) instead of the
        // field errors - the session/IP must solve a human check on the site
        if (data && (data.show_captcha || data.captcha_required || data.requires_captcha || data.error === true)) {
            return { ok: false, error: 'bandcamp wants a human check - log in once on the site inside the app, then you are set' };
        }
        const errMsg = typeof data?.error === 'string' && data.error ? data.error : '';
        return { ok: false, error: errMsg || 'login failed' };
    }

    /** read the raw identity cookie value (for persisting a fresh login). */
    async identityCookieValue(): Promise<string> {
        try {
            const cs = await this.getSession()?.cookies.get({ url: 'https://bandcamp.com', name: 'identity' });
            return cs?.[0]?.value || '';
        } catch { return ''; }
    }

    /** bandcamp's authoritative owned-item count (collection_summary lookup size). 0 if unknown. */
    async fetchOwnedTotal(): Promise<number> {
        const session = this.getSession();
        if (!session) return 0;
        try {
            const r = await session.fetch('https://bandcamp.com/api/fan/2/collection_summary', { credentials: 'include' } as any);
            if (!r.ok) return 0;
            const d: any = await r.json();
            const lookup = d?.collection_summary?.tralbum_lookup;
            return lookup && typeof lookup === 'object' ? Object.keys(lookup).length : 0;
        } catch { return 0; }
    }

    // --- session diagnostics + manual session (paste-cookie login) -------------

    /** bandcamp cookies in the session store. names + flags only, never values. */
    async sessionCookies(): Promise<{ name: string; domain: string; secure: boolean; httpOnly: boolean; session: boolean; sameSite: string; expiry: number }[]> {
        const session = this.getSession();
        if (!session) return [];
        try {
            const all = await session.cookies.get({});
            return all
                .filter((c) => (c.domain || '').includes('bandcamp'))
                .map((c) => ({
                    name: c.name,
                    domain: c.domain || '',
                    secure: !!c.secure,
                    httpOnly: !!c.httpOnly,
                    session: !!c.session,
                    sameSite: String(c.sameSite || ''),
                    expiry: c.expirationDate || 0,
                }));
        } catch { return []; }
    }

    /** full session picture for diagnostics: cookie inventory + fan resolution. */
    async sessionStatus(): Promise<{ fanId: string; fromCookie: boolean; summaryOk: boolean; hasIdentity: boolean; cookies: { name: string; domain: string; secure: boolean; httpOnly: boolean; session: boolean; sameSite: string; expiry: number }[] }> {
        const cookies = await this.sessionCookies();
        const hasIdentity = cookies.some((c) => c.name === 'identity');
        let fanId = '';
        let fromCookie = false;
        if (hasIdentity) {
            fanId = await this.fanIdFromCookie();
            fromCookie = !!fanId;
        }
        if (!fanId) fanId = await this.getFanId();
        let summaryOk = false;
        if (fanId) {
            try {
                const r = await this.getSession()!.fetch('https://bandcamp.com/api/fan/2/collection_summary', { credentials: 'include' } as any);
                summaryOk = r.ok;
            } catch { /* stays false */ }
        }
        return { fanId, fromCookie, summaryOk, hasIdentity, cookies };
    }

    /**
     * install an identity cookie by hand (the paste-cookie login flow).
     * returns true when the cookie landed in the store.
     */
    async setIdentityCookie(value: string): Promise<boolean> {
        const session = this.getSession();
        const v = (value || '').trim();
        if (!session || !v) return false;
        try {
            await session.cookies.set({
                url: 'https://bandcamp.com',
                name: 'identity',
                value: v,
                domain: '.bandcamp.com',
                path: '/',
                secure: true,
                httpOnly: true,
                expirationDate: Math.floor(Date.now() / 1000) + 86400 * 90,
            });
            this.cachedFanId = '';
            this.cachedFanUsername = '';
            return true;
        } catch { return false; }
    }

    /** drop the identity cookie + forget the cached fan. */
    async clearSession(): Promise<void> {
        try { await this.getSession()?.cookies.remove('https://bandcamp.com', 'identity'); } catch { /* ignore */ }
        this.cachedFanId = '';
        this.cachedFanUsername = '';
    }

    /** normalize one feed story entry (fields vary between story types & api versions). */
    private normalizeStory(s: any): FeedStory | null {
        if (!s || typeof s !== 'object') return null;
        const tralbumId = toId(s.item_id ?? s.tralbum_id ?? s.album_id);
        if (!tralbumId) return null;
        const typeRaw = String(s.item_type ?? s.tralbum_type ?? 'a');
        const artId = toId(s.item_art_id ?? s.art_id);
        const date = Number(s.story_date_ts ?? 0) ||
            Math.floor(Date.parse(String(s.story_date || s.new_release_date || '')) / 1000) || 0;
        const year = Number(String(s.new_release_date || s.release_date || '').match(/\b(19|20)\d{2}\b/)?.[0]) || 0;
        return {
            type: String(s.story_type || '').trim() || 'nr',
            date: date > 0 ? date : 0,
            title: String(s.item_title ?? s.album_title ?? s.title ?? '').trim(),
            artist: String(s.band_name ?? s.artist ?? '').trim(),
            art: artId ? `https://f4.bcbits.com/img/a${artId}_9.jpg` : '',
            url: String(s.item_url ?? s.tralbum_url ?? '').trim(),
            tralbumId,
            tralbumType: (typeRaw === 't' || typeRaw === 'track') ? 't' : 'a',
            bandId: toId(s.band_id ?? s.selling_band_id),
            trackId: toId(s.featured_track ?? s.featured_track_id ?? s.track_id),
            via: String(s.fan_name ?? '').trim(),
            year,
        };
    }

    /**
     * one page of the fan feed (stories from artists & fans you follow) via the
     * same endpoint bandcamp's own "older stories" button posts to. olderThan is
     * the unix ts to page back from (0/omitted = newest).
     */
    async fetchFeed(olderThan = 0): Promise<{ ok: boolean; stories: FeedStory[]; oldest: number; error?: string }> {
        const session = this.getSession();
        if (!session) return { ok: false, stories: [], oldest: 0, error: 'no session' };
        const fanId = await this.getFanId();
        if (!fanId) return { ok: false, stories: [], oldest: 0, error: 'not logged in' };
        this.noteInteractive(); // feed paging is user-driven: crawler yields to it
        // first page of a load/reload: poke the feed page so the snapshot is fresh
        if (!(olderThan > 0)) await this.regenerateFeed();
        let data: any = null;
        try {
            const body = new URLSearchParams({
                fan_id: fanId,
                older_than: String(olderThan > 0 ? olderThan : Math.floor(Date.now() / 1000) + 3600),
            }).toString();
            for (let attempt = 0; ; attempt++) {
                const r = await session.fetch('https://bandcamp.com/fan_dash_feed_updates', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body,
                    credentials: 'include',
                } as any);
                if (r.ok) { data = await r.json(); break; }
                this.notify429(r.status);
                // throttled: retry a few times with backoff before giving up
                if (r.status !== 429 || attempt >= 3) return { ok: false, stories: [], oldest: 0, error: 'http ' + r.status };
                await new Promise((res) => setTimeout(res, 1000 * Math.pow(2, attempt)));
            }
        } catch (e: any) {
            return { ok: false, stories: [], oldest: 0, error: e?.message || 'feed fetch failed' };
        }
        // entries live under .stories on the web endpoint; be lenient about shape
        const root = (data && typeof data === 'object' && (data.stories || data)) || {};
        const rawEntries: any[] = Array.isArray(root.entries) ? root.entries
            : Array.isArray(root.stories) ? root.stories
            : Array.isArray(data?.entries) ? data.entries : [];
        const stories: FeedStory[] = [];
        let oldest = 0;
        for (const s of rawEntries) {
            const n = this.normalizeStory(s);
            if (!n) continue;
            if (n.date && (!oldest || n.date < oldest)) oldest = n.date;
            stories.push(n);
        }
        const rootOldest = Number(root.oldest_story_date) || 0;
        if (rootOldest && (!oldest || rootOldest < oldest)) oldest = rootOldest;
        return { ok: true, stories, oldest };
    }

    // --- global search (bandcamp's public search api) -------------------------

    /**
     * site-wide search via bandcamp's own public endpoint (the one their search
     * box uses). filter: '' all, 't' tracks, 'a' albums, 'b' artists/labels.
     */
    async searchPublic(text: string, filter: '' | 't' | 'a' | 'b' = ''): Promise<{
        ok: boolean;
        results: { type: string; id: string; name: string; band: string; album: string; art: string; url: string; bandId: string; albumId: string }[];
        error?: string;
    }> {
        const session = this.getSession();
        if (!session || !text.trim()) return { ok: false, results: [], error: 'no query' };
        this.noteInteractive(); // user-driven: the index crawler yields
        try {
            const r = await session.fetch('https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ search_text: text.trim(), search_filter: filter, full_page: true, fan_id: null }),
                credentials: 'include',
            } as any);
            if (!r.ok) { this.notify429(r.status); return { ok: false, results: [], error: 'http ' + r.status }; }
            const d: any = await r.json();
            const rows: any[] = d?.auto?.results || d?.results || [];
            return {
                ok: true,
                results: rows.map((x: any) => {
                    // the api's `img` field uses the no-prefix image-id form, which
                    // only exists for band/fan photos - for tracks/albums it 404s
                    // (dead icons). release art must be built from art_id with the
                    // `a` prefix.
                    const artId = toId(x.art_id);
                    const isRelease = x.type === 't' || x.type === 'a';
                    const art = isRelease
                        ? (artId ? hiResArt(`https://f4.bcbits.com/img/a${artId}_9.jpg`) : String(x.img || '').trim())
                        : (String(x.img || '').trim() || (artId ? hiResArt(`https://f4.bcbits.com/img/a${artId}_9.jpg`) : ''));
                    return {
                        type: String(x.type || ''),
                        id: toId(x.id),
                        name: String(x.name || '').trim(),
                        band: String(x.band_name || '').trim(),
                        album: String(x.album_name || '').trim(),
                        art,
                        url: String(x.item_url_path || x.item_url_root || '').trim(),
                        bandId: toId(x.band_id),
                        // the api never sends album_id: for albums `id` IS the
                        // tralbum id (what fetchTralbum/resolveRelease need);
                        // tracks resolve through their parent album by track id.
                        albumId: toId(x.type === 'a' ? x.id : x.album_id),
                        trackId: toId(x.type === 't' ? x.id : x.track_id),
                    };
                }).filter((x: any) => x.name),
            };
        } catch (e: any) {
            return { ok: false, results: [], error: e?.message || 'search failed' };
        }
    }

    // --- header search bar (autocomplete api + discover api) ------------------

    /**
     * site-wide search for the header bar. bandcamp's search *page* is fully
     * site-wide search for the header bar. bandcamp's search *page* serves
     * server-rendered li.searchresult rows to trusted (cookie-bearing) sessions,
     * so we fetch it like a browser and parse the rows - they carry the full
     * metadata (tracks count, duration, year, tags, location) plus the tralbum
     * ids via data-search. paginated through &page=N (the site's own paging),
     * so infinite scroll stays one page at a time. mode maps straight to its
     * filter: album='a', artist='b', track='t', all=''.
     */
    async searchPage(text: string, mode: 'all' | 'album' | 'artist' | 'track' = 'all', page = 1): Promise<{
        ok: boolean;
        items: SearchResultItem[];
        hasMore: boolean;
        error?: string;
    }> {
        const session = this.getSession();
        if (!session || !text.trim()) return { ok: false, items: [], hasMore: false, error: 'no query' };
        this.noteInteractive(); // user-driven: the index crawler yields
        const filter = mode === 'album' ? 'a' : mode === 'artist' ? 'b' : mode === 'track' ? 't' : '';
        const url = 'https://bandcamp.com/search?q=' + encodeURIComponent(text.trim()) +
            (filter ? '&item_type=' + filter : '') + '&page=' + Math.max(1, page);
        try {
            const r = await session.fetch(url, { credentials: 'include' } as any);
            if (!r.ok) { this.notify429(r.status); return { ok: false, items: [], hasMore: false, error: 'http ' + r.status }; }
            const html = await r.text();
            return {
                ok: true,
                items: parseSearchPageHtml(html),
                // pagination links (&page=N) only render while more pages exist
                hasMore: /[?&]page=\d+/.test(html),
            };
        } catch (e: any) {
            return { ok: false, items: [], hasMore: false, error: e?.message || 'search failed' };
        }
    }

    /**
     * genre-mode search: the discover api's tag filter returns albums carrying
     * that tag, paged via its opaque cursor (24 per page). an unknown tag yields
     * zero results on the first page, which falls back to a plain album search
     * of the text; later empty pages just mean the list ran out.
     */
    async searchGenre(text: string, cursor = '*'): Promise<{
        ok: boolean;
        items: SearchResultItem[];
        nextCursor: string;
        error?: string;
    }> {
        const session = this.getSession();
        if (!session || !text.trim()) return { ok: false, items: [], nextCursor: '', error: 'no query' };
        this.noteInteractive(); // user-driven: the index crawler yields
        const tag = text.trim();
        try {
            const r = await session.fetch('https://bandcamp.com/api/discover/1/discover_web', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    category_id: 0, cursor, geoname_id: 0,
                    include_result_types: ['a'], size: 24, slice: 'top',
                    tag_norm_names: [tag], time_facet_id: null,
                }),
                credentials: 'include',
            } as any);
            if (!r.ok) { this.notify429(r.status); return { ok: false, items: [], nextCursor: '', error: 'http ' + r.status }; }
            const d: any = await r.json();
            const rows: any[] = (d?.results || []).filter((x: any) => x?.result_type === 'a');
            if (rows.length) {
                return {
                    ok: true,
                    nextCursor: String(d?.cursor || ''),
                    items: rows.map((x: any): SearchResultItem => {
                        const artId = toId(x.primary_image?.image_id);
                        let url = String(x.item_url || '').trim();
                        if (url) {
                            try {
                                const u = new URL(url);
                                if (u.searchParams.get('from') === 'discover_page') {
                                    u.searchParams.delete('from');
                                    u.searchParams.delete('from_item_id');
                                    u.searchParams.delete('from_discover_category');
                                }
                                url = u.toString();
                            } catch { /* keep raw */ }
                        }
                        const item: SearchResultItem = {
                            type: 'album',
                            name: String(x.title || '').trim(),
                            url,
art: hiResArt(artId ? `https://f4.bcbits.com/img/a${artId}_9.jpg` : ''),
                            artist: String(x.album_artist || x.band_name || '').trim(),
                            genre: tag,
                        };
                        if (x.band_location) item.location = String(x.band_location).trim();
                        const rawDate = x.release_date;
                        if (rawDate != null && rawDate !== '') {
                            let y = 0;
                            if (typeof rawDate === 'number') y = new Date(rawDate > 1e12 ? rawDate : rawDate * 1000).getFullYear();
                            else { const t = Date.parse(String(rawDate)); if (!isNaN(t)) y = new Date(t).getFullYear(); }
                            if (y > 1900 && y < 3000) item.year = y;
                        }
                        return item;
                    }).filter((i: SearchResultItem) => i.name && i.url),
                };
            }
            // first page with zero rows = unknown tag: fall back to an album
            // search of the text. later empty pages just mean the list ran out.
            if (cursor === '*') {
                const fallback = await this.searchPage(text, 'album', 1);
                return { ok: fallback.ok, items: fallback.items, nextCursor: '', error: fallback.error };
            }
            return { ok: true, items: [], nextCursor: '' };
        } catch (e: any) {
            // discover hiccup: fall through to the album search (first page only)
            if (cursor === '*') {
                const fallback = await this.searchPage(text, 'album', 1);
                return { ok: fallback.ok, items: fallback.items, nextCursor: '', error: fallback.error };
            }
            return { ok: false, items: [], nextCursor: '', error: (e as any)?.message || 'genre search failed' };
        }
    }

    /**
     * trending albums from bandcamp's discover app (the same endpoint the
     * /discover page uses; no tag filter = the general "top" slice). the home
     * page's discover rail. rows carry resolver handles so they can play
     * straight from the rail.
     */
    async fetchDiscover(size = 24, cursor = '*'): Promise<{ ok: boolean; items: SearchResultItem[]; nextCursor?: string; error?: string }> {
        const session = this.getSession();
        if (!session) return { ok: false, items: [], error: 'no session' };
        this.noteInteractive(); // user-driven: the crawler yields
        try {
            const r = await session.fetch('https://bandcamp.com/api/discover/1/discover_web', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    category_id: 0, cursor, geoname_id: 0,
                    include_result_types: ['a'], size, slice: 'top',
                    tag_norm_names: [], time_facet_id: null,
                }),
                credentials: 'include',
            } as any);
            if (!r.ok) { this.notify429(r.status); return { ok: false, items: [], error: 'http ' + r.status }; }
            const d: any = await r.json();
            const rows: any[] = (d?.results || []).filter((x: any) => x?.result_type === 'a');
            return {
                ok: true,
                items: rows.map((x: any): SearchResultItem => {
                    const artId = toId(x.primary_image?.image_id);
                    let url = String(x.item_url || '').trim();
                    if (url) {
                        try {
                            const u = new URL(url);
                            if (u.searchParams.get('from') === 'discover_page') {
                                u.searchParams.delete('from');
                                u.searchParams.delete('from_item_id');
                                u.searchParams.delete('from_discover_category');
                            }
                            url = u.toString();
                        } catch { /* keep raw */ }
                    }
                    const item: SearchResultItem = {
                        type: 'album',
                        name: String(x.title || '').trim(),
                        url,
                        art: hiResArt(artId ? `https://f4.bcbits.com/img/a${artId}_9.jpg` : ''),
                        artist: String(x.album_artist || x.band_name || '').trim(),
                        genre: '',
                    };
                    // resolver handles so the home rail can play straight away
                    (item as any).tralbumId = toId(x.item_id);
                    (item as any).bandId = toId(x.band_id ?? x.selling_band_id);
                    if (x.band_location) item.location = String(x.band_location).trim();
                    const rawDate = x.release_date;
                    if (rawDate != null && rawDate !== '') {
                        let y = 0;
                        if (typeof rawDate === 'number') y = new Date(rawDate > 1e12 ? rawDate : rawDate * 1000).getFullYear();
                        else { const t = Date.parse(String(rawDate)); if (!isNaN(t)) y = new Date(t).getFullYear(); }
                        if (y > 1900 && y < 3000) item.year = y;
                    }
                    return item;
                }).filter((i: SearchResultItem) => i.name && i.url),
                nextCursor: String(d?.cursor ?? d?.next_cursor ?? '') || undefined,
            };
        } catch (e: any) {
            return { ok: false, items: [], error: e?.message || 'discover fetch failed' };
        }
    }

    // --- artist pages (the artist view) --------------------------------------

    /** one artist page's worth of data for the artist view: identity, banner,
     * follow state, bio and the discography (tralbum ids, art, page urls). all
     * from the server-rendered page: the data-band json, the follow-info
     * attribute and the discography array attribute on the grid section. */
    async getArtistPage(url: string): Promise<ArtistPageData> {
        const fail = (error: string): ArtistPageData => ({ ok: false, error, bandId: '', name: '', url, photoUrl: '', bannerUrl: '', location: '', website: '', bio: '', isFollowing: false, discography: [] });
        const session = this.getSession();
        if (!session || !url) return fail('no query');
        this.noteInteractive(); // user-driven: the index crawler yields
        try {
            const r = await session.fetch(url, { credentials: 'include' } as any);
            if (!r.ok) { this.notify429(r.status); return fail('page fetch failed (' + r.status + ')'); }
            const html = await r.text();
            const decode = (s: string): string => String(s || '')
                .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'")
                .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&');
            const jsonAttr = (name: string): any | null => {
                const m = html.match(new RegExp(name + '="([^"]+)"'));
                if (!m) return null;
                try { return JSON.parse(decode(m[1])); } catch { return null; }
            };
            const band = jsonAttr('data-band');
            const followInfo = jsonAttr('data-band-follow-info');
            if (!band || !followInfo) return fail('not an artist page');
            const bandId = toId(band.id);
            // band root: data-band usually carries url/https_url, but bands whose
            // root url is a (featured) tralbum page ship none - the page origin
            // is the band's own subdomain, so derive it from there.
            let bandUrl = String(band.url || band.https_url || '').trim();
            if (!bandUrl) {
                try { bandUrl = new URL(url).origin; } catch { bandUrl = ''; }
            }
            const name = String(band.name || '').trim();
            // artist photo: the follow-info carries the band image id; the
            // banner is the desktop header image. artist images live under
            // img/{id}_{fmt} (no 'a' prefix - that's album art).
            const photoUrl = followInfo.band_image_id
                ? `https://f4.bcbits.com/img/${toId(followInfo.band_image_id)}_23.jpg` : '';
            const bannerUrl = band.header_desktop?.image_id
                ? `https://f4.bcbits.com/img/${toId(band.header_desktop.image_id)}_100.png` : '';
            // "Name.\nUK.\n" - the location is the second line of the meta
            // description. tralbum landing pages describe the release instead
            // (a long tracklist) - only trust short descriptions.
            let location = '';
            const md = html.match(/<meta name="description" content="([^"]*)"/);
            if (md && String(md[1]).length < 200) {
                const lines = String(md[1]).replace(/&amp;/g, '&').split(/\s*\n\s*/).map((s) => s.trim()).filter(Boolean);
                if (lines.length > 1) location = lines.slice(1).join(' ');
            }
            const site = Array.isArray(band.sites) ? band.sites.map((s: any) => String(s.url || '')).find(Boolean) : '';
            // the discography grid section carries the release list as a
            // data-client-items array right before the first music-grid-item li.
            // newer layouts ship no such attribute - the ids sit on the li
            // itself (data-item-id / data-band-id) with an optional
            // artist-override span for VA/label releases.
            const strip = (s: string): string => String(s || '')
                .replace(/<[^>]*>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            const parseDiscography = (h: string): ArtistPageData['discography'] => {
                const out: ArtistPageData['discography'] = [];
                const gridIdx = h.indexOf('music-grid-item');
                if (gridIdx === -1) return out;
                const attrIdx = h.lastIndexOf('data-client-items="', gridIdx);
                if (attrIdx !== -1) {
                    const start = attrIdx + 'data-client-items="'.length;
                    const end = h.indexOf('"', start);
                    if (end !== -1) {
                        try {
                            const rows: any[] = JSON.parse(decode(h.slice(start, end)));
                            return rows
                                .filter((x: any) => (x.type === 'album' || x.type === 'track') && x.id && x.page_url)
                                .map((x: any): ArtistPageData['discography'][number] => ({
                                    tralbumId: toId(x.id),
                                    tralbumType: x.type === 'track' ? 't' : 'a',
                                    title: String(x.title || '').trim(),
                                    art: toId(x.art_id) ? `https://f4.bcbits.com/img/a${toId(x.art_id)}_9.jpg` : '',
                                    url: bandUrl + String(x.page_url || ''),
                                    artist: String(x.artist || name).trim(),
                                    bandId: toId(x.band_id ?? bandId),
                                    year: 0,
                                }));
                        } catch { /* fall through to the per-item parse */ }
                    }
                }
                const liRe = /<li[^>]*data-item-id="(album|track)-(\d+)"[^>]*data-band-id="(\d+)"[^>]*>([\s\S]*?)<\/li>/g;
                let m: RegExpExecArray | null;
                while ((m = liRe.exec(h))) {
                    const type = m[1] === 'track' ? 't' : 'a';
                    const id = toId(m[2]);
                    const liBand = toId(m[3]);
                    const body = m[4];
                    const href = /<a[^>]*href="([^"]+)"/.exec(body)?.[1] || '';
                    if (!id || !href) continue;
                    // lazy-loaded items show a 0.gif placeholder in src; the
                    // real cover only lives in data-original
                    const imgTag = /<img[^>]*>/.exec(body)?.[0] || '';
                    const art = /data-original="([^"]+)"/.exec(imgTag)?.[1] || /<img[^>]*src="([^"]+)"/.exec(body)?.[1] || '';
                    const override = /<span class="artist-override">([\s\S]*?)<\/span>/.exec(body)?.[1];
                    const titleHtml = /<p class="title">([\s\S]*?)<\/p>/.exec(body)?.[1] || '';
                    const title = decode(strip(override ? titleHtml.replace(/<span class="artist-override">[\s\S]*?<\/span>/, '') : titleHtml));
                    if (!title) continue;
                    out.push({
                        tralbumId: id,
                        tralbumType: type,
                        title,
                        art: art.replace(/&amp;/g, '&'),
                        url: bandUrl + String(href || '').replace(/&amp;/g, '&'),
                        artist: decode(strip(override || '')) || name,
                        bandId: liBand,
                        year: 0,
                    });
                }
                return out;
            };
            let discography = parseDiscography(html);
            // bands whose root url IS their (featured) tralbum page render no
            // discography grid at all - the full catalog lives on /music.
            if (!discography.length) {
                try {
                    const mu = await session.fetch(bandUrl.replace(/\/+$/, '') + '/music', { credentials: 'include' } as any);
                    if (mu.ok) discography = parseDiscography(await mu.text());
                } catch { /* keep the empty list */ }
            }
            // single-release bands serve the ALBUM page at the root AND at
            // /music - synthesize the one-item discography from its meta.
            if (!discography.length) {
                const props = /<meta name="bc-page-properties" content="([^"]*)"/.exec(html);
                if (props) {
                    try {
                        const p = JSON.parse(decode(props[1]));
                        if (p && p.item_type === 'a' && p.item_id) {
                            const ogUrl = /<meta property="og:url"\s+content="([^"]*)"/.exec(html)?.[1] || '';
                            const ogTitle = /<meta property="og:title"\s+content="([^"]*)"/.exec(html)?.[1] || '';
                            const ogImage = /<meta property="og:image"\s+content="([^"]*)"/.exec(html)?.[1] || '';
                            const title = decode(ogTitle.replace(/,\s*by\s+[\s\S]*$/i, '').trim());
                            const by = /,\s*by\s+([\s\S]*)$/i.exec(ogTitle);
                            if (title && ogUrl) {
                                discography.push({
                                    tralbumId: toId(p.item_id),
                                    tralbumType: 'a',
                                    title,
                                    art: ogImage.replace(/&amp;/g, '&'),
                                    url: ogUrl.replace(/&amp;/g, '&'),
                                    artist: decode(by ? by[1].trim() : '') || name,
                                    bandId,
                                    year: 0,
                                });
                            }
                        }
                    } catch { /* keep the empty list */ }
                }
            }
            // years are NOT fetched here: that would fire one tralbum call per
            // release up front (a rate-limit burst on big catalogs). the main
            // process streams them in paced, one by one, after the view renders.
            let bio = '';
            const bioIdx = html.indexOf('signed-out-artists-bio-text');
            if (bioIdx !== -1) {
                const gt = html.indexOf('>', bioIdx);
                const end = gt === -1 ? -1 : html.indexOf('</div>', gt);
                if (gt !== -1 && end !== -1) bio = this.htmlToText(html.slice(gt + 1, end));
            }
            return {
                ok: true,
                bandId,
                name,
                url: bandUrl,
                photoUrl,
                bannerUrl,
                location,
                website: site,
                bio,
                isFollowing: !!followInfo.is_following,
                discography,
            };
        } catch (e: any) {
            return fail(e?.message || 'artist fetch failed');
        }
    }

    /** everything the album view needs about one release: the tralbum page's
     * data-tralbum blob (title/artist/art/release date/about/credits/tracks)
     * plus the band name from data-band for the header. */
    async getAlbumPage(url: string): Promise<AlbumPageData> {
        const fail = (error: string): AlbumPageData => ({ ok: false, error, url, bandId: '', bandUrl: '', bandName: '', title: '', artist: '', artUrl: '', year: 0, releaseDate: '', genre: '', about: '', credits: [], tracks: [], tralbumId: '', tralbumType: 'a' });
        const session = this.getSession();
        if (!session || !url) return fail('no query');
        this.noteInteractive(); // user-driven: the index crawler yields
        try {
            const r = await session.fetch(url, { credentials: 'include' } as any);
            if (!r.ok) { this.notify429(r.status); return fail('page fetch failed (' + r.status + ')'); }
            const html = await r.text();
            const decode = (s: string): string => String(s || '')
                .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'")
                .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&');
            const jsonAttr = (name: string): any | null => {
                const m = html.match(new RegExp(name + '="([^"]+)"'));
                if (!m) return null;
                try { return JSON.parse(decode(m[1])); } catch { return null; }
            };
            const data = jsonAttr('data-tralbum');
            if (!data) return fail('not a release page');
            const band = jsonAttr('data-band');
            const cur = data.current || {};
            const bandId = toId(band?.id || cur.band_id || '');
            let bandUrl = String(band?.url || band?.https_url || '').trim();
            if (!bandUrl) { try { bandUrl = new URL(url).origin; } catch { bandUrl = ''; } }
            const bandName = String(band?.name || data.band?.name || cur.artist || '').trim();
            const title = String(data.album_title || cur.title || data.title || '').trim();
            const artist = String(cur.artist || data.artist || data.tralbum_artist || bandName || '').trim();
            const artId = toId(data.art_id ?? cur.art_id);
            const artUrl = artId ? `https://f4.bcbits.com/img/a${artId}_10.jpg` : '';
            const year = this.extractYear(data);
            let releaseDate = '';
            if (Number(data.release_date) > 0) {
                try { releaseDate = new Date(Number(data.release_date) * 1000).toISOString().slice(0, 10); } catch { /* keep '' */ }
            }
            // the page lists the release's tags as meta keywords (first = genre)
            let genre = '';
            const kw = html.match(/<meta name="keywords" content="([^"]*)"/);
            if (kw) {
                const parts = String(kw[1]).split(',').map((s) => s.trim()).filter(Boolean);
                if (parts.length) genre = parts[0];
            }
            const about = this.htmlToText(String(data.about || ''));
            const credits = (Array.isArray(data.credits) ? data.credits : [])
                .map((c: any) => ({ name: String(c?.name || '').trim(), role: String(c?.role || '').trim() }))
                .filter((c: any) => c.name);
            const rows: any[] = Array.isArray(data.trackinfo) ? data.trackinfo : [];
            const tracks = rows.map((t: any, i: number) => {
                // per-track artist when set, else the release's own artist - the
                // UPLOADER (label) is only a fallback, never the row's artist
                const trkArtist = String((t && (t.artist || t.band_name)) || '').trim() || artist;
                let title = String((t && t.title) || '').trim() || `Track ${i + 1}`;
                // some releases (notably VA compilations) ship titles already
                // composed as "artist - title" while also carrying the artist
                // separately; the row shows both columns, so drop the prefix.
                if (trkArtist) {
                    const esc = trkArtist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const m = title.match(new RegExp('^' + esc + '\\s*[-–—]\\s+'));
                    if (m) title = title.slice(m[0].length).trim() || title;
                }
                return {
                    id: String((t && (t.id || t.track_id)) || ''),
                    title,
                    artist: trkArtist,
                    duration: Math.max(0, Math.floor(Number(t && t.duration) || 0)),
                };
            });
            return { ok: true, url, bandId, bandUrl, bandName, title, artist, artUrl, year, releaseDate, genre, about, credits, tracks, tralbumId: toId(data.id), tralbumType: data.type === 'track' ? 't' : 'a' };
        } catch (e: any) {
            return fail(e?.message || 'release fetch failed');
        }
    }

    /** follow/unfollow a band through the fan's session. the page's data-crumbs
     * carry the signed crumb and follow-info the fan id; POST goes to the same
     * /fan_follow_band_cb endpoint the site uses (multipart form). */
    async followBand(bandUrl: string, bandId: string, follow: boolean): Promise<{ ok: boolean; isFollowing?: boolean; error?: string }> {
        const session = this.getSession();
        if (!session || !bandUrl || !bandId) return { ok: false, error: 'no query' };
        this.noteInteractive();
        try {
            const r = await session.fetch(bandUrl, { credentials: 'include' } as any);
            if (!r.ok) { this.notify429(r.status); return { ok: false, error: 'page fetch failed (' + r.status + ')' }; }
            const html = await r.text();
            const decode = (s: string): string => String(s || '')
                .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'")
                .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&');
            const crumbsM = html.match(/id="js-crumbs-data" data-crumbs="([^"]+)"/);
            const followM = html.match(/data-band-follow-info="([^"]+)"/);
            if (!crumbsM || !followM) return { ok: false, error: 'follow data missing (not signed in?)' };
            let crumb = '';
            let fanId = '';
            try {
                const crumbs = JSON.parse(decode(crumbsM[1]));
                crumb = String(crumbs.fan_follow_band_cb || '');
                const fi = JSON.parse(decode(followM[1]));
                fanId = toId(fi.fan_id);
            } catch { return { ok: false, error: 'unreadable follow data' }; }
            if (!crumb || !fanId) return { ok: false, error: 'follow data missing (not signed in?)' };
            const fd = new FormData();
            fd.append('band_id', bandId);
            fd.append('action', follow ? 'follow' : 'unfollow');
            fd.append('fan_id', fanId);
            fd.append('crumb', crumb);
            const post = await session.fetch('https://bandcamp.com/fan_follow_band_cb', { method: 'POST', credentials: 'include', body: fd } as any);
            if (!post.ok) { this.notify429(post.status); return { ok: false, error: 'follow failed (' + post.status + ')' }; }
            const d: any = await post.json();
            if (d?.ok && typeof d.is_following === 'boolean') return { ok: true, isFollowing: d.is_following };
            return { ok: false, error: d?.error_message || d?.error || 'follow failed' };
        } catch (e: any) {
            return { ok: false, error: e?.message || 'follow failed' };
        }
    }

    // --- bandcamp fan playlists (import) -------------------------------------

    /** fetch + parse a fan playlist page (bandcamp.com/playlist/…). */
    async fetchBandcampPlaylist(url: string): Promise<BandcampPlaylistPage> {
        this.noteInteractive();
        const session = this.getSession();
        if (!session) return playlistPageError('app session not ready');
        try {
            const r = await session.fetch(url, { credentials: 'include' } as any);
            if (!r.ok) return playlistPageError(`page fetch failed (${r.status})`);
            return parseBandcampPlaylistHtml(await r.text());
        } catch (err: any) {
            return playlistPageError(err?.message || 'fetch failed');
        }
    }

    // --- stream downloads (unowned releases) ---------------------------------

    /**
     * crude html→plain-text for scraped lyric rows. tag stripping loops to a
     * fixed point so nested/split tags can never leave residue like "<script",
     * and entities decode AFTER the strip with &amp; handled LAST - decoding it
     * first turned "&amp;quot;" into '"' (double-unescape). the output is only
     * ever written into id3 text frames, never rendered as html.
     */
    private htmlToText(html: string): string {
        let s = String(html || '').replace(/<br\s*\/?>/gi, '\n');
        for (let prev = ''; prev !== s;) { prev = s; s = s.replace(/<[^>]*>/g, ''); }
        return s
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .trim();
    }

    /**
     * everything needed to download a release's streams with proper tags: album,
     * album artist, year, cover url, and per-track title/artist/number/lyrics/
     * stream url. accepts a page url (richest payload - the page blob can carry
     * lyrics) or tralbum ids.
     */
    async fetchReleaseForDownload(q: { url?: string; tralbumId?: string; tralbumType?: TralbumType; bandId?: string }): Promise<{
        ok: boolean; error?: string;
        album: string; albumArtist: string; year: number; artUrl: string;
        tracks: { id: string; title: string; artist: string; trackNum: number; lyrics: string; stream: string; duration: number }[];
    }> {
        this.noteInteractive();
        const empty = (error: string) => ({ ok: false, error, album: '', albumArtist: '', year: 0, artUrl: '', tracks: [] });
        let data: any = null;
        // page blob first (has lyrics when the artist published them)
        if (q.url && /^https:\/\//.test(q.url)) {
            const session = this.getSession();
            if (session) {
                try {
                    const r = await session.fetch(q.url, { credentials: 'include' } as any);
                    if (r.ok) {
                        const html = await r.text();
                        const m = html.match(/data-tralbum="([^"]+)"/);
                        if (m) {
                            try { data = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')); } catch { /* fall through */ }
                        }
                        // lyrics usually are NOT in the blob - the page renders them
                        // as <tr id="lyrics_row_<trackNum>"> rows (BandcampDownloader
                        // does the same scrape)
                        if (data && Array.isArray(data.trackinfo)) {
                            for (const t of data.trackinfo) {
                                if (t && !t.lyrics && t.track_num) {
                                    const lm = html.match(new RegExp('id="lyrics_row_' + t.track_num + '"[^>]*>([\\s\\S]*?)</tr>', 'i'));
                                    if (lm) {
                                        const text = this.htmlToText(lm[1]);
                                        if (text) t.lyrics = text;
                                    }
                                }
                            }
                        }
                    }
                } catch { /* fall through to api */ }
            }
        }
        if (!data && q.tralbumId) {
            const type: TralbumType = q.tralbumType === 't' ? 't' : 'a';
            data = await this.fetchRaw(type, toId(q.tralbumId), q.bandId);
        }
        if (!data || typeof data !== 'object') return empty('could not load the release');

        const cur = data.current || {};
        const albumArtist = String(cur.artist || data.artist || data.tralbum_artist || (data.band && data.band.name) || '').trim() || 'Unknown Artist';
        const album = String(data.album_title || cur.title || data.title || '').trim() || 'Unknown Release';
        const year = this.extractYear(data);
        const artId = toId(data.art_id ?? cur.art_id);
        const artUrl = artId ? `https://f4.bcbits.com/img/a${artId}_10.jpg` : '';
        const rows: any[] = Array.isArray(data.trackinfo) ? data.trackinfo : Array.isArray(data.tracks) ? data.tracks : [];
        const tracks = rows.map((t: any, i: number) => ({
            id: String((t && (t.id || t.track_id)) || ''),
            title: String((t && t.title) || '').trim() || `Track ${i + 1}`,
            artist: String((t && (t.artist || t.band_name)) || '').trim() || albumArtist,
            trackNum: Number(t && t.track_num) || i + 1,
            lyrics: typeof t?.lyrics === 'string' ? t.lyrics : '',
            stream: pickStream(t && (t.file || t.streaming_url || t.mp3_url)),
            duration: Math.max(0, Math.floor(Number(t && t.duration) || 0)),
        })).filter((t) => t.stream);
        if (!tracks.length) return empty('no streamable tracks (private or preorder?)');
        return { ok: true, album, albumArtist, year, artUrl, tracks };
    }

    // --- downloads (purchased items) ----------------------------------------

    // fetch a download page & pull its per-format popplers urls. downloadPageUrl
    // is the redownload_url from the collection (bandcamp.com/download?...).
    async fetchDownloadFormats(downloadPageUrl: string): Promise<DownloadFormat[]> {
        const session = this.getSession();
        if (!session || !downloadPageUrl) return [];
        let html = '';
        try {
            const r = await session.fetch(downloadPageUrl, { credentials: 'include' } as any);
            if (!r.ok) return [];
            html = await r.text();
        } catch {
            return [];
        }
        // the page carries a #pagedata data-blob with digital_items[].downloads
        const m = html.match(/id="pagedata"[^>]*data-blob="([^"]*)"/);
        if (!m) return [];
        let blob: any;
        try {
            blob = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
        } catch {
            return [];
        }
        const item = Array.isArray(blob?.digital_items) ? blob.digital_items[0] : null;
        const downloads = item?.downloads || {};
        const out: DownloadFormat[] = [];
        for (const enc of Object.keys(downloads)) {
            const dl = downloads[enc];
            if (dl && dl.url) out.push({ encoding: enc, label: (dl.description || enc).toString(), url: dl.url.toString() });
        }
        return out;
    }

    // some formats aren't encoded yet; the download url has a sibling statdownload
    // endpoint that reports ready + the final file url. poll it, then fall back to
    // the raw url (bandcamp also streams the zip directly once prepared).
    async prepareDownload(formatUrl: string): Promise<string> {
        const session = this.getSession();
        if (!session || !formatUrl) return formatUrl;
        const statUrl = formatUrl.replace('/download/', '/statdownload/') + '&.vrs=1&.rand=' + Math.floor(Math.random() * 1e9);
        for (let i = 0; i < 45; i++) {
            try {
                const r = await session.fetch(statUrl, { credentials: 'include' } as any);
                const text = await r.text();
                const jm = text.match(/\{[\s\S]*\}/); // strip any jsonp wrapper
                if (jm) {
                    const j = JSON.parse(jm[0]);
                    if (j.result === 'ok' && (j.download_url || j.url)) return (j.download_url || j.url).toString();
                    if (j.result === 'err') return formatUrl;
                }
            } catch {
                // keep polling
            }
            await new Promise((res) => setTimeout(res, 2000));
        }
        return formatUrl;
    }
}

// --- bandcamp fan playlist page parsing --------------------------------------
// a /playlist/<id> page ships a data-blob attribute whose appData carries the
// playlist (title/description/imageId) and every track with its band id, parent
// album id, art id and duration - exactly the resolver handles our own playlist
// entries store. stream urls in the blob are short-lived and deliberately
// ignored; playback resolves lazily like everything else.

export interface BandcampPlaylistTrack {
    id: string;
    title: string;
    artist: string;
    album: string;
    /** parent album id; '' for standalone tracks */
    albumId: string;
    bandId: string;
    artId: string;
    duration: number;
    url: string;
}

export interface BandcampPlaylistPage {
    ok: boolean;
    error?: string;
    playlistId: number;
    title: string;
    description: string;
    imageId: number;
    tracks: BandcampPlaylistTrack[];
}

/** everything the artist view needs about one band. */
export interface ArtistPageData {
    ok: boolean;
    error?: string;
    bandId: string;
    name: string;
    url: string;
    photoUrl: string;
    bannerUrl: string;
    location: string;
    website: string;
    bio: string;
    isFollowing: boolean;
    discography: {
        tralbumId: string;
        tralbumType: 'a' | 't';
        title: string;
        art: string;
        url: string;
        artist: string;
        bandId: string;
        year: number;
    }[];
}

/** everything the album view needs about one release. */
export interface AlbumPageData {
    ok: boolean;
    error?: string;
    url: string;
    bandId: string;
    bandUrl: string;
    bandName: string;
    title: string;
    artist: string;
    artUrl: string;
    year: number;
    releaseDate: string;
    genre: string;
    about: string;
    credits: { name: string; role: string }[];
    tracks: { id: string; title: string; artist: string; duration: number }[];
    tralbumId: string;
    tralbumType: 'a' | 't';
}

export function playlistPageError(error: string): BandcampPlaylistPage {
    return { ok: false, error, playlistId: 0, title: '', description: '', imageId: 0, tracks: [] };
}

/**
 * parse the search *page's* server-rendered li.searchresult rows. each row
 * carries the tralbum ids in its data-search json ({type, id}), the art, and
 * rich meta: heading, subhead (artist/location), tracks count + length,
 * release date, tags. never runs in the browser - this is regex over a saved
 * fetch, so entity-decoding is done by hand (&amp; strictly last).
 */
export function parseSearchPageHtml(html: string): SearchResultItem[] {
    const items: SearchResultItem[] = [];
    const strip = (s: string): string => String(s || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const liRe = /<li[^>]*class="searchresult[^>]*data-search="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g;
    let m: RegExpExecArray | null;
    while ((m = liRe.exec(html))) {
        const ds = String(m[1]).replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&amp;/g, '&');
        let type = '';
        let id = '';
        try {
            const d = JSON.parse(ds);
            type = String(d.type || '');
            id = String(d.id || '');
        } catch { /* unreadable row - skip */ }
        if (type !== 'a' && type !== 'b' && type !== 't') continue;
        const body = m[2];
        const name = strip(/<div class="heading">([\s\S]*?)<\/div>/.exec(body)?.[1] || '');
        const href = /<a class="artcont"[^>]*href="([^"]+)"/.exec(body)?.[1] || '';
        if (!name || !href) continue;
        const url = href.replace(/&amp;/g, '&').split('?')[0];
        const art = hiResArt(/<img[^>]*src="([^"]+)"/.exec(body)?.[1] || '');
        let sub = strip(/<div class="subhead">([\s\S]*?)<\/div>/.exec(body)?.[1] || '').replace(/^by\s+/i, '');
        const item: SearchResultItem = {
            type: type === 'a' ? 'album' : type === 'b' ? 'artist' : 'track',
            name,
            url,
            art,
            bandId: type === 'b' ? id : '',
            albumId: type === 'a' ? id : '',
            trackId: type === 't' ? id : '',
        };
        if (item.type !== 'artist') item.artist = sub;
        else if (sub) item.location = sub;
        const lenTxt = strip(/<div class="length">([\s\S]*?)<\/div>/.exec(body)?.[1] || '');
        if (lenTxt) {
            const nt = /(\d+)\s*tracks?/.exec(lenTxt);
            if (nt) item.numTracks = Number(nt[1]);
            const min = /(\d+)\s*minutes?/.exec(lenTxt);
            if (min) item.duration = Number(min[1]) * 60;
        }
        const rel = strip(/<div class="released">([\s\S]*?)<\/div>/.exec(body)?.[1] || '');
        const yr = /(19|20)\d{2}/.exec(rel);
        if (yr) { const y = Number(yr[0]); if (y > 1900 && y < 3000) item.year = y; }
        const tagsTxt = strip(/<div class="tags[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(body)?.[1] || '');
        if (tagsTxt) item.tags = tagsTxt.replace(/^tags:\s*/i, '');
        items.push(item);
    }
    return items;
}

/** pure parser so it can be tested against saved pages (no network). */
export function parseBandcampPlaylistHtml(html: string): BandcampPlaylistPage {
    const m = String(html || '').match(/data-blob="([^"]+)"/);
    if (!m) return playlistPageError('no page data found (is that a playlist url?)');
    // attribute unescape: &amp; strictly LAST or "&amp;quot;" double-unescapes
    return parseBandcampPlaylistBlob(m[1]
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&'));
}

/** parse an already-decoded data-blob json string (e.g. read via getAttribute in-page). */
export function parseBandcampPlaylistBlob(raw: string): BandcampPlaylistPage {
    let blob: any = null;
    try { blob = JSON.parse(String(raw || '')); } catch { return playlistPageError('unreadable page data'); }
    const appData = blob?.appData;
    const rows: any[] = appData?.tracklist?.tracks;
    if (!appData || !Array.isArray(rows)) return playlistPageError('not a bandcamp playlist page');
    const tracks: BandcampPlaylistTrack[] = rows.map((t: any) => ({
        id: toId(t?.id),
        title: String(t?.title || '').trim() || 'untitled',
        artist: String(t?.artistName || '').trim(),
        album: String(t?.album?.title || '').trim(),
        albumId: toId(t?.album?.id),
        bandId: toId(t?.bandId),
        artId: toId(t?.artId ?? t?.album?.artId),
        duration: Math.max(0, Math.round(Number(t?.duration) || 0)),
        url: typeof t?.url === 'string' ? t.url : '',
    })).filter((t) => t.id);
    return {
        ok: true,
        playlistId: Number(appData.playlistId) || 0,
        title: String(appData.title || '').trim() || 'Imported playlist',
        description: String(appData.description || ''),
        imageId: Number(appData.imageId) || 0,
        tracks,
    };
}
