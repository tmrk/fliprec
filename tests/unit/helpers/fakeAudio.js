import { vi } from 'vitest';

const allocatedTrackList = [];

/** Tracks created by {@link createFakeTrack} since the helper was loaded. */
export function allocatedTracks() {
  return allocatedTrackList.slice();
}

function createAudioParam(initial) {
  const param = {
    value: initial,
    defaultValue: initial,
    events: [],
    setValueAtTime: vi.fn((value, time) => {
      param.value = value;
      param.events.push({ type: 'set', value, time });
      return param;
    }),
    linearRampToValueAtTime: vi.fn((value, time) => {
      param.events.push({ type: 'linear', value, time });
      param.value = value;
      return param;
    }),
    exponentialRampToValueAtTime: vi.fn((value, time) => {
      param.events.push({ type: 'exp', value, time });
      param.value = value;
      return param;
    }),
    cancelScheduledValues: vi.fn((time) => {
      param.events.push({ type: 'cancel', time });
      return param;
    }),
    setTargetAtTime: vi.fn((value, time, constant) => {
      param.events.push({ type: 'target', value, time, constant });
      return param;
    }),
  };
  return param;
}

/**
 * Minimal AudioContext. Channel data is real Float32Array storage.
 * `currentTime` is controllable. Sources and gains record start/stop and automation.
 */
export function createFakeAudioContext(options = {}) {
  let currentTime = options.currentTime ?? 0;
  const sources = [];
  const gains = [];
  const analysers = [];
  const streamSources = [];
  const events = [];
  const destination = { id: 'destination' };

  const ctx = {
    sampleRate: options.sampleRate ?? 48000,
    state: options.state ?? 'running',
    destination,
    sources,
    gains,
    analysers,
    streamSources,
    events,
    resume: vi.fn(() => {
      ctx.state = 'running';
      return Promise.resolve();
    }),
    suspend: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setCurrentTime(time) {
      currentTime = time;
    },
    advance(seconds) {
      currentTime += seconds;
    },
    createBuffer(numberOfChannels, length, sampleRate) {
      const channels = Array.from(
        { length: numberOfChannels },
        () => new Float32Array(length),
      );
      const rate = sampleRate || ctx.sampleRate;
      return {
        numberOfChannels,
        length,
        sampleRate: rate,
        get duration() {
          return rate > 0 ? length / rate : 0;
        },
        getChannelData(index) {
          return channels[index];
        },
        copyToChannel(source, index, start = 0) {
          channels[index].set(source, start);
        },
        copyFromChannel(destinationArray, index, start = 0) {
          destinationArray.set(channels[index].subarray(start, start + destinationArray.length));
        },
      };
    },
    createBufferSource() {
      const source = {
        buffer: null,
        onended: null,
        playbackRate: createAudioParam(1),
        started: false,
        stopped: false,
        startWhen: null,
        offset: 0,
        playDuration: undefined,
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      source.start = vi.fn((when = 0, offset = 0, duration) => {
        const live = sources.filter((item) => item.started && !item.stopped);
        events.push({ type: 'start', live: live.length });
        source.started = true;
        source.startWhen = when;
        source.offset = offset;
        source.playDuration = duration;
      });
      source.stop = vi.fn((when = 0) => {
        events.push({ type: 'stop', when });
        source.stopped = true;
        source.stopWhen = when;
      });
      source.dispatchEnded = () => {
        if (typeof source.onended === 'function') source.onended();
      };
      sources.push(source);
      return source;
    },
    createGain() {
      const gain = {
        gain: createAudioParam(1),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(gain);
      return gain;
    },
    createMediaStreamSource(stream) {
      const node = {
        mediaStream: stream,
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      streamSources.push(node);
      return node;
    },
    createAnalyser() {
      const analyser = {
        fftSize: 2048,
        smoothingTimeConstant: 0.8,
        timeDomain: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        get frequencyBinCount() {
          return analyser.fftSize >> 1;
        },
        getFloatTimeDomainData(array) {
          const fill = analyser.timeDomain;
          if (!fill) {
            array.fill(0);
            return;
          }
          const n = Math.min(array.length, fill.length);
          for (let i = 0; i < n; i += 1) array[i] = fill[i];
          for (let i = n; i < array.length; i += 1) array[i] = 0;
        },
      };
      analysers.push(analyser);
      return analyser;
    },
  };

  Object.defineProperty(ctx, 'currentTime', {
    configurable: true,
    enumerable: true,
    get() {
      return currentTime;
    },
    set(value) {
      currentTime = value;
    },
  });

  return ctx;
}

export function createFakeTrack(kind = 'audio') {
  const listeners = new Map();
  const track = {
    kind,
    id: `track-${createFakeTrack.nextId}`,
    label: 'Fake microphone',
    enabled: true,
    muted: false,
    readyState: 'live',
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      listeners.set(type, list.filter((item) => item !== fn));
    },
    dispatch(type, extra = {}) {
      const event = { type, target: track, ...extra };
      for (const fn of [...(listeners.get(type) || [])]) fn(event);
    },
  };
  allocatedTrackList.push(track);
  createFakeTrack.nextId += 1;
  track.stop = vi.fn(() => {
    if (track.readyState === 'ended') return;
    track.readyState = 'ended';
    track.dispatch('ended');
  });
  return track;
}

createFakeTrack.nextId = 1;

export function createFakeStream(trackCount = 1) {
  const tracks = Array.from({ length: trackCount }, () => createFakeTrack('audio'));
  return {
    getTracks() {
      return tracks.slice();
    },
    getAudioTracks() {
      return tracks.slice();
    },
    getVideoTracks() {
      return [];
    },
  };
}

export function installFakeMediaRecorder(options = {}) {
  const previous = globalThis.MediaRecorder;
  const instances = [];
  const supported = options.supported ?? ((mime) => mime.includes('webm'));

  class FakeMediaRecorder {
    constructor(stream, recorderOptions = {}) {
      this.stream = stream;
      this.recorderOptions = recorderOptions;
      this.mimeType = recorderOptions.mimeType || options.defaultMimeType || '';
      this.audioBitsPerSecond = recorderOptions.audioBitsPerSecond;
      this.state = 'inactive';
      this.timeslice = null;
      this.handlers = new Map();
      this.chunks = (options.chunks || [
        new Blob(['a']),
        new Blob(['b']),
      ]).slice();
      instances.push(this);
    }

    start(timeslice) {
      this.timeslice = timeslice;
      this.state = 'recording';
      this.dispatch('start');
    }

    stop() {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      for (const chunk of this.chunks) {
        this.dispatch('dataavailable', { data: chunk });
      }
      this.dispatch('stop');
    }

    addEventListener(type, fn) {
      const list = this.handlers.get(type) || [];
      list.push(fn);
      this.handlers.set(type, list);
    }

    removeEventListener(type, fn) {
      const list = this.handlers.get(type) || [];
      this.handlers.set(type, list.filter((item) => item !== fn));
    }

    dispatch(type, extra = {}) {
      const event = { type, target: this, ...extra };
      const direct = this[`on${type}`];
      if (typeof direct === 'function') direct(event);
      for (const fn of [...(this.handlers.get(type) || [])]) fn(event);
    }

    static isTypeSupported(mime) {
      return supported(mime);
    }
  }

  globalThis.MediaRecorder = FakeMediaRecorder;
  return {
    instances,
    restore() {
      if (previous === undefined) delete globalThis.MediaRecorder;
      else globalThis.MediaRecorder = previous;
    },
  };
}

export function installFakeUserMedia(getUserMedia) {
  const nav = globalThis.navigator;
  const previous = nav.mediaDevices;
  const mediaDevices = {
    getUserMedia: vi.fn(getUserMedia || (async () => createFakeStream())),
  };
  nav.mediaDevices = mediaDevices;
  return {
    mediaDevices,
    restore() {
      if (previous === undefined) delete nav.mediaDevices;
      else nav.mediaDevices = previous;
    },
  };
}
