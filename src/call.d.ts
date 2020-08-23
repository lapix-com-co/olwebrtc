declare interface ExternalControls {
  video: boolean;
  audio: boolean;
}

declare interface MessageContent {
  type: "ec" | "message";
  data: any;
}

declare interface EventMap {
  "track-change": undefined;
  "local-track-change": undefined;
  change: undefined;
  finish: undefined;
  message: MessageContent;
  error: Error;
}

declare interface CallMediaStreamConstraints {
  camera: MediaStreamConstraints;
  screen: MediaStreamConstraints;
}

declare interface StartInput {
  roomId: string;
  mediaStreamConstrains: CallMediaStreamConstraints;
}

declare interface NetworkStatus {
  isOnline<K extends { timeout: number }>(op: K): Promise<boolean>;
  on(type: "change", cb: (isOnline: boolean) => any): void;
  off(type: "change", cb: (isOnline: boolean) => any): void;
}

declare type DeviceType = "camera" | "microphone" | "screen";

declare interface Statistics<K> {
  find(peer: RTCPeerConnection): Promise<K>;
}

/**
 * Handles a video call.
 */
declare interface Call {
  finished: boolean;
  /**
   * Has been open to the signaling server.
   */
  readonly connected: boolean;

  /**
   * Has been open with the other peer.
   */
  readonly matched: boolean;

  /**
   * Current browser MediaStream.
   */
  readonly localStream?: MediaStream;

  /**
   * Peer MediaStream.
   */
  readonly peerStream?: MediaStream;

  /**
   * Is the current video track active.
   */
  readonly video: boolean;

  /**
   * Is the current audio track active.
   */
  readonly audio: boolean;

  /**
   * Peer's controls state.
   */
  readonly externalControls?: ExternalControls;

  /**
   * Begin the call in the given room id.
   * @param input
   */
  start(input: StartInput): Promise<void>;

  /**
   * Finish the current call.
   */
  finish(): Promise<void>;

  /**
   * Clean removes the allocated resources but
   * does not finish the current call.
   */
  clean(): Promise<void>;

  /**
   * Get the local available devices.
   */
  getDevices(): Promise<MediaDeviceInfo[]>;

  /**
   * Get the current device's streams.
   */
  askUserMedia(c: MediaStreamConstraints): Promise<boolean>;

  /**
   * Change the current audio status.
   */
  toggleAudio(): Promise<void>;

  /**
   * Change the current video status.
   */
  toggleVideo(): Promise<void>;

  /**
   * Replace the tracks when the selected device is an input device.
   * @param newDevice
   */
  setActiveDevice(newDevice: MediaDeviceInfo): Promise<void>;

  /**
   * Selected a new device.
   */
  nextVideoDevice(): Promise<void>;

  /**
   * Shares the current screen with the microphone audio.
   */
  shareScreen(): Promise<void>;

  /**
   * Shares the camera video with the microphone audio.
   */
  shareVideo(): Promise<void>;

  /**
   * Send arbitrary data to the other peer.
   * @param data
   */
  send(data: string): void;
  send(data: Blob): void;
  send(data: ArrayBuffer): void;
  send(data: ArrayBufferView): void;

  /**
   * Indicates the call state change.
   * @param type
   * @param listener
   */
  on<K extends keyof EventMap>(
      type: K,
      listener: (ev: EventMap[K]) => any
  ): void;

  off<K extends keyof EventMap>(
      type: K,
      listener: (ev: EventMap[K]) => any
  ): void;
}
