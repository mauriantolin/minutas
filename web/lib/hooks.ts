"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { getMeeting, listMeetings, type Meeting, type MeetingDetail } from "@/lib/api";

export interface UseMeetingsResult {
  meetings: Meeting[] | null;
  loading: boolean;
  error: string | null;
  /** Silent refresh (does not flip `loading`); safe for polling. */
  refetch: () => Promise<void>;
}

export function useMeetings(): UseMeetingsResult {
  const { token } = useAuth();
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!token) return;
    try {
      const r = await listMeetings(token);
      setMeetings(r.meetings);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [token]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { meetings, loading: meetings === null && !error, error, refetch };
}

export interface UseMeetingResult {
  meeting: MeetingDetail | null;
  loading: boolean;
  error: string | null;
  /** Silent refresh (does not flip `loading`); safe for polling. */
  refetch: () => Promise<void>;
  /** Optimistic local patch (e.g. after a rename or tag toggle). */
  mutate: (patch: Partial<MeetingDetail>) => void;
}

export function useMeeting(id: string | null): UseMeetingResult {
  const { token } = useAuth();
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMeeting(null);
    setError(null);
  }, [id]);

  const refetch = useCallback(async () => {
    if (!token || !id) return;
    try {
      setMeeting(await getMeeting(token, id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [token, id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const mutate = useCallback((patch: Partial<MeetingDetail>) => {
    setMeeting((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  return { meeting, loading: meeting === null && !error && id !== null, error, refetch, mutate };
}

const XL_QUERY = "(min-width: 1280px)";

/**
 * Tracks Tailwind's xl breakpoint. `undefined` until the first client
 * measurement — callers should render neither variant of xl-dependent UI
 * during that frame so a component is never mounted twice.
 */
export function useIsXl(): boolean | undefined {
  const [isXl, setIsXl] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    const mql = window.matchMedia(XL_QUERY);
    const onChange = () => setIsXl(mql.matches);
    mql.addEventListener("change", onChange);
    onChange();
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isXl;
}

/**
 * Runs `fn` every `intervalMs` ms; pass null to pause (e.g. only poll while
 * `status === "processing"`). `fn` needs no memoization.
 */
export function usePolling(intervalMs: number | null, fn: () => void | Promise<void>): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (intervalMs === null) return;
    const timer = setInterval(() => void fnRef.current(), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
}
