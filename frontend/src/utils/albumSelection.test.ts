import { describe, it, expect } from 'vitest';
import { getAlbumCheckState, getNewPendingAction } from './albumSelection';

describe('albumSelection', () => {
  describe('getAlbumCheckState', () => {
    const albumId = 1;
    const photoAlbumMap: Record<number, number[]> = {
      101: [1, 2],
      102: [2, 3],
      103: [1],
    };

    it('returns true if all photos are in the album', () => {
      const photoIds = [101, 103];
      expect(getAlbumCheckState(albumId, photoIds, photoAlbumMap)).toBe(true);
    });

    it('returns false if no photos are in the album', () => {
      const photoIds = [102];
      expect(getAlbumCheckState(albumId, photoIds, photoAlbumMap)).toBe(false);
    });

    it('returns null (indeterminate) if only some photos are in the album', () => {
      const photoIds = [101, 102];
      expect(getAlbumCheckState(albumId, photoIds, photoAlbumMap)).toBe(null);
    });

    it('returns false if photoIds is empty', () => {
      expect(getAlbumCheckState(albumId, [], photoAlbumMap)).toBe(false);
    });
  });

  describe('getNewPendingAction', () => {
    it('returns add when checked and original state was false', () => {
      expect(getNewPendingAction(true, false)).toBe('add');
    });

    it('returns add when checked and original state was indeterminate', () => {
      expect(getNewPendingAction(true, null)).toBe('add');
    });

    it('returns delete_pending when checked and original state was true', () => {
      expect(getNewPendingAction(true, true)).toBe('delete_pending');
    });

    it('returns remove when unchecked and original state was true', () => {
      expect(getNewPendingAction(false, true)).toBe('remove');
    });

    it('returns remove when unchecked and original state was indeterminate', () => {
      expect(getNewPendingAction(false, null)).toBe('remove');
    });

    it('returns delete_pending when unchecked and original state was false', () => {
      expect(getNewPendingAction(false, false)).toBe('delete_pending');
    });
  });
});
