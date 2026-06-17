import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  scheduleFeedPush,
  flushUser,
  buildFeedDigest,
  __setFeedPushDeps,
  __resetFeedPush,
  type FeedPushEvent,
} from "./feed-push-debounce";
import type { PushPayload } from "./push.service";

function sendMock() {
  return vi.fn(async (_userId: number, _payload: PushPayload) => ({ sent: 1, pruned: 0 }));
}

function ev(over: Partial<FeedPushEvent> = {}): FeedPushEvent {
  return {
    kind: "photo_favorited",
    actorName: "Anna",
    albumName: "Urlaub",
    albumId: 5,
    photoId: 9,
    payload: {},
    ...over,
  };
}

describe("feed-push-debounce", () => {
  beforeEach(() => {
    __resetFeedPush();
  });

  it("suppresses the push entirely while the recipient is online", async () => {
    const send = sendMock();
    __setFeedPushDeps({ isOnline: async () => true, send });

    await scheduleFeedPush(1, ev());
    await flushUser(1); // nothing was buffered

    expect(send).not.toHaveBeenCalled();
  });

  it("delivers a single buffered event as a normal notification", async () => {
    const send = sendMock();
    __setFeedPushDeps({ isOnline: async () => false, send, quietMs: 60_000, maxWaitMs: 120_000 });

    await scheduleFeedPush(1, ev({ kind: "photo_favorited" }));
    await flushUser(1);

    expect(send).toHaveBeenCalledOnce();
    const [uid, payload] = send.mock.calls[0]!;
    expect(uid).toBe(1);
    expect(payload.title).toBe("Neuer Favorit");
  });

  it("coalesces multiple events for one recipient into a single digest", async () => {
    const send = sendMock();
    __setFeedPushDeps({ isOnline: async () => false, send });

    await scheduleFeedPush(1, ev({ kind: "photo_favorited", photoId: 9 }));
    await scheduleFeedPush(1, ev({ kind: "photo_favorited", photoId: 10 }));
    await scheduleFeedPush(1, ev({ kind: "photo_commented", photoId: 11, payload: { excerpt: "hi" } }));
    await flushUser(1);

    expect(send).toHaveBeenCalledOnce();
    const payload = send.mock.calls[0]![1];
    expect(payload.body).toContain("2 neue Favoriten");
    expect(payload.body).toContain("1 neuer Kommentar");
    expect(payload.tag).toBe("vivanty-feed-digest");
  });

  it("drops the push if the recipient comes back online before the flush", async () => {
    let online = false;
    const send = sendMock();
    __setFeedPushDeps({ isOnline: async () => online, send });

    await scheduleFeedPush(1, ev()); // enqueued while offline
    online = true; // user returns to the app
    await flushUser(1);

    expect(send).not.toHaveBeenCalled();
  });

  it("buffers events per recipient independently", async () => {
    const send = sendMock();
    __setFeedPushDeps({ isOnline: async () => false, send });

    await scheduleFeedPush(1, ev());
    await scheduleFeedPush(2, ev());
    await flushUser(1);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toBe(1);
  });

  it("buildFeedDigest sums photo_added counts and links to the shared album", () => {
    const p = buildFeedDigest([
      ev({ kind: "photo_added", payload: { photoIds: [1, 2, 3] } }),
      ev({ kind: "photo_added", payload: { photoIds: [4] } }),
    ]);
    expect(p.body).toContain("4 neue Fotos");
    expect(p.url).toBe("/app/fotos/alben/5");
  });

  it("buildFeedDigest links to the feed when events span albums", () => {
    const p = buildFeedDigest([ev({ albumId: 1 }), ev({ albumId: 2 })]);
    expect(p.url).toBe("/app/fotos/feed");
  });
});
