import { TinyEmitter } from "tiny-emitter";
import sdpTransform from "sdp-transform";
import { Bitrate, BitRateStats } from "./bitrate";
import logger from "./log";
import { LogLevelDesc } from "loglevel";
import {CallError, DeviceError, ErrorCodes} from "./errors";

type BandWidthLimit = number | "unlimited";

interface WebRTCCallOptions {
  signaling: Signaling;
  network: NetworkStatus;
  rtcConfiguration: RTCConfiguration;
  allowSDPTransform?: boolean;
  allowBitrateChecking?: boolean;
  allowIceStalledChecking?: boolean;
  bandwidth?: BandWidthLimit;
  logLevel?: LogLevelDesc;
}

export class WebRTCCall implements Call {
  private _localStream?: MediaStream;
  private _audioStream?: MediaStreamTrack;
  private _videoStream?: MediaStreamTrack;
  private _videoDevice?: MediaDeviceInfo;
  private _audioDevice?: MediaDeviceInfo;

  private _peerStream?: MediaStream;
  private rtcPeerConnection?: RTCPeerConnection;
  private roomId?: string;
  private emitter: TinyEmitter = new TinyEmitter();

  private dataChannel?: RTCDataChannel;
  private dataChannelOpen: boolean = false;
  private mediaStreamConstrains?: MediaStreamConstraints;
  private _finished: boolean = false;
  private listeningForNetworkChange: boolean = false;
  private iceQueue: RTCIceCandidate[] = [];
  private iceFailed: boolean = false;
  private _externalControls?: ExternalControls;
  private hasSignalingListeners: boolean = false;
  private _peerVideo?: MediaStreamTrack[];
  private _peerAudio?: MediaStreamTrack[];
  private runninDisconnectionStrategy: boolean = false;
  private bitRateLog?: Bitrate;
  private allowSDPTransform: boolean;
  private signaling: Signaling;
  private network: NetworkStatus;
  private rtcConfiguration: RTCConfiguration;
  private allowBitrateChecking: boolean = false;
  private allowIceStalledChecking: boolean;
  private bandwidth: BandWidthLimit;

  constructor(options: WebRTCCallOptions) {
    this.signaling = options.signaling;
    this.network = options.network;
    this.rtcConfiguration = options.rtcConfiguration;
    this.allowSDPTransform = options.allowSDPTransform !== undefined;
    this.allowBitrateChecking = options.allowBitrateChecking || false;
    this.allowIceStalledChecking = options.allowIceStalledChecking || false;
    this.bandwidth = options.bandwidth || 600;

    logger.setLevel(typeof options.logLevel !== "number" ? logger.levels.WARN : options.logLevel);

    if (typeof window !== "undefined") {
      // @ts-ignore
      window.call = this;
    }

    if (logger.getLevel() <= logger.levels.INFO && this.allowBitrateChecking) {
      setInterval(async () => this.logBitRate(), 1000);
    }
  }

  async start(input: StartInput): Promise<void> {
    this.roomId = input.roomId;
    this.mediaStreamConstrains = input.mediaStreamConstrains;
    this._finished = false;

    const result = await this.getMediaStream();

    if (result) {
      this._setupSignalingListeners();
      if (!this.signaling.connected) {
        await this.signaling.connect({ id: this.roomId });
      }
    } else {
      logger.warn(
        "[DEVICES] Does not have permissions to get the media streams"
      );
    }

    this.emitter.emit("change");

    return;
  }

  private _setupSignalingListeners(): void {
    if (this.hasSignalingListeners) {
      logger.info("[SIGNALING] signaling listeners has been added");
      return;
    }

    logger.info("[SIGNALING] adding signaling listeners");
    this.hasSignalingListeners = true;

    this.signaling.on("newPeer", this.onNewPeer.bind(this));

    this.signaling.on("newOffer", async ({ sdp }) => {
      logger.info(
        "[SIGNALING] newOffer received, the signaling state is: ",
        this.rtcPeerConnection?.signalingState
      );

      const created = await this.createPeerConnection();
      if (!created) {
        return;
      }

      await this.rtcPeerConnection?.setRemoteDescription(sdp);
      await this.getMediaStreamAndAddTracks();
      const answer = (await this.rtcPeerConnection?.createAnswer()) as RTCSessionDescription;
      this.sanitizeSDP(answer);
      this.updateBandWidth(answer);

      this.logConnectionsStates();
      await this.rtcPeerConnection?.setLocalDescription(answer);
      await this.signaling.sendSDPAnswer({
        sdp: answer,
        roomId: this.roomId as string,
      });
    });

    this.signaling.on("newAnswer", ({ sdp }) => {
      const validState: RTCSignalingState[] = [
        "have-local-offer",
        "have-remote-pranswer",
      ];
      if (
        this.rtcPeerConnection &&
        validState.indexOf(this.rtcPeerConnection.signalingState) >= 0
      ) {
        logger.info(
          "[SIGNALING] newAnswer received, has current descriptor?",
          this.rtcPeerConnection?.currentRemoteDescription
        );
        this.logConnectionsStates();
        this.sanitizeSDP(sdp);
        this.rtcPeerConnection?.setRemoteDescription(sdp);
      } else {
        logger.warn(
          "[SIGNALING] received a new answer but the we have not created a local offer: ",
          this.rtcPeerConnection?.signalingState
        );
      }
    });

    this.signaling.on("newIceCandidate", ({ candidate }) => {
      if (this.rtcPeerConnection?.remoteDescription) {
        logger.info("[SIGNALING] add new ice candidate");
        this.addIceCandidate(candidate);
      } else if (this.rtcPeerConnection?.signalingState === "stable") {
        this.logConnectionsStates();
        logger.warn(
          "[SIGNALING] receive a new ice candidate but we have not a local descriptor or a remote descriptor"
        );
      } else {
        this.iceQueue.push(candidate);
      }
    });

    this.signaling.on("error", (error) => {
      logger.error("[SIGNALING] error from the signaling server", error);
      this.emitter.emit("error", error);
      this.emitter.emit("change");
    });

    this.signaling.on("finished", () => {
      logger.info("[SIGNALING] remote peer has finished the call");
      this.finish();
    });
  }

  private async onNewPeer() {
    logger.info("[SIGNALING] New peer connected");

    const created = await this.createPeerConnection();
    if (!created) {
      return;
    }

    await this.getMediaStreamAndAddTracks();

    this.dataChannel = this.rtcPeerConnection?.createDataChannel(
      "data-channel",
      { ordered: true }
    );

    if (this.dataChannel) {
      this.addDataChannelListeners(this.dataChannel);
    } else {
      logger.error(
        "[SIGNALING] could not set the data channel listener because the channel returned by the 'createDataChannel' is empty"
      );
    }
  }

  private async createPeerConnection(): Promise<boolean> {
    logger.info("[SIGNALING] will create a new peer");

    // If we have a valid connection lets close it.
    if (this.rtcPeerConnection) {
      this.clean();
    }

    try {
      this.rtcPeerConnection = new RTCPeerConnection(this.rtcConfiguration);
      this.setupListeners(this.rtcPeerConnection);
      return true;
    } catch (e) {
      this.rtcPeerConnection = undefined;
      this.emitter.emit("error", e);

      if (!this._finished) {
        await this.needReconnection();
      }

      return false;
    }
  }

  public askUserMedia(c: MediaStreamConstraints): Promise<boolean> {
    logger.debug("[DEVICES] will ask the devices with the following constrains", c);
    this.mediaStreamConstrains = c;
    return this.getMediaStream();
  }

  private async getMediaStream(): Promise<boolean> {
    logger.debug("[DEVICES] will ask for the current devices");
    let devices = null;

    try {
      devices = await navigator.mediaDevices.enumerateDevices();
      logger.info("[DEVICES] current devices", devices);
    } catch (e) {
      this.handleDeviceError(e, "camera");
      return false;
    }

    const videoConstrains: MediaStreamConstraints = {
      video: this.mediaStreamConstrains?.video,
    };
    const audioConstrains: MediaStreamConstraints = {
      audio: this.mediaStreamConstrains?.audio,
    };

    // Check if the device is alredy pluged-in.
    if (this._videoDevice) {
      this._videoDevice = devices.find(
        (device) => device.deviceId === this._videoDevice?.deviceId
      );
    }

    // Check if the device is alredy pluged-in.
    if (this._audioDevice) {
      this._audioDevice = devices.find(
        (device) => device.deviceId === this._audioDevice?.deviceId
      );
    }

    // If we have a 'front' cam, will select it.
    if (!this._videoDevice) {
      this._videoDevice = devices.find((device) => {
        // @ts-ignore This works only in ReactNative.
        if (device.facing) {
          // @ts-ignore
          return device.facing === "front";
        }

        return device.kind === "videoinput" && !device.label.match(/back|rear/);
      });

      // Otherwise select the first one.
      if (!this._videoDevice) {
        this._videoDevice = devices.find(
          (device) => device.kind === "videoinput"
        );
      }
    }

    if (!this._audioDevice) {
      this._audioDevice = devices.find(
        (device) => device.kind === "audioinput"
      );
    }

    (videoConstrains.video as MediaTrackConstraints).deviceId = this._videoDevice?.deviceId;
    (audioConstrains.audio as MediaTrackConstraints).deviceId = this._audioDevice?.deviceId;

    try {
      this._videoStream = (
        await navigator.mediaDevices.getUserMedia(videoConstrains)
      )
        .getVideoTracks()
        .find((v) => v.enabled) as MediaStreamTrack;
    } catch (e) {
      this.handleDeviceError(e, "camera");
      return false;
    }

    try {
      this._audioStream = (
        await navigator.mediaDevices.getUserMedia(audioConstrains)
      )
        .getAudioTracks()
        .find((a) => a.enabled) as MediaStreamTrack;
    } catch (e) {
      this.handleDeviceError(e, "microphone");
      return false;
    }

    this._localStream = new MediaStream([this._videoStream, this._audioStream]);
    this.emitter.emit("local-track-change");

    return true;
  }

  private handleDeviceError(e: DOMException, deviceType: DeviceType): void {
    const permissionError = new DeviceError(
      `Need access to the ${deviceType} to start the video call`,
      ErrorCodes.DEVICE_PERMISSION_ERROR,
      deviceType
    );
    const constrainsError = new DeviceError(
      `Could not find any valid ${deviceType}`,
      ErrorCodes.DEVICE_NOT_FOUND_ERROR,
      deviceType
    );

    switch (e.name) {
      case "AbortError":
        this.emitter.emit("error", permissionError);
        return;
      case "SecurityError":
      case "NotAllowedError":
        this.emitter.emit("error", permissionError);
        return;
      case "NotFoundError":
      case "NotReadableError":
      case "OverconstrainedError":
        this.emitter.emit("error", constrainsError);
        return;
    }

    logger.error(`[DEVICES] error in the ${deviceType} request`, e);
    throw e;
  }

  private setupListeners(peer: RTCPeerConnection): void {
    peer.onicecandidate = this.onicecandidate.bind(this);
    peer.ontrack = this.ontrack.bind(this);
    peer.ondatachannel = this.ondatachannel.bind(this);
    peer.onnegotiationneeded = this.onnegotiationneeded.bind(this);
    peer.onsignalingstatechange = this.onsignalingstatechange.bind(this);
    peer.oniceconnectionstatechange = this.oniceconnectionstatechange.bind(
      this
    );
    peer.onicegatheringstatechange = this.onicegatheringstatechange.bind(this);
    peer.onconnectionstatechange = this.onconnectionstatechange.bind(this);

    if (!peer.addTrack) {
      // @ts-ignore RectNative compatibility.
      peer.onaddstream = this.onaddstream.bind(this);
    }
  }

  private async getMediaStreamAndAddTracks(): Promise<boolean> {
    if (!this.localStream) {
      await this.getMediaStream();
    }

    this.addTracks();
    return true;
  }

  private addTracks(): void {
    if (!this._localStream) {
      throw new Error(
        "could not add tracks because the local media stream is empty"
      );
    }

    if (!this.rtcPeerConnection?.addTrack) {
      // @ts-ignore ReactNative compatibility.
      if (!this.rtcPeerConnection?.addStream) {
        this.emitter.emit(
          "error",
          new CallError(
            "Current runtime does not support (addTrack|addStream) method",
            ErrorCodes.SUPPORT_ERROR
          )
        );
      }

      // @ts-ignore
      this.rtcPeerConnection?.addStream(this._localStream);
      return;
    }

    const hasTracks = this.rtcPeerConnection.getSenders().some((sender) => {
      return !!sender.track;
    });

    if (hasTracks) {
      logger.warn(
        "[NEGOTIATION] does not need to add track because the sender already has"
      );
      return;
    }

    this._localStream
      .getTracks()
      .map((track) =>
        this.rtcPeerConnection?.addTrack(
          track,
          this._localStream as MediaStream
        )
      );
  }

  async finish(): Promise<void> {
    if (this._finished) {
      logger.warn('the call has been finished')
      return
    }

    if (!this.roomId) {
      throw new Error(
        "Could not disconnect from the room because the roomId is empty"
      );
    }

    const roomId = this.roomId;
    this.roomId = undefined;
    this.mediaStreamConstrains = undefined;
    this._finished = true;

    this.clean();
    this.releaseTracks();

    try {
      await this.signaling.finish({ id: roomId });
    } catch (e) {
      logger.error(e);
    }

    try {
      await this.signaling.disconnect({ id: roomId });
    } catch (e) {
      logger.error(e);
    }

    this.emitter.emit("finish");
    this.emitter.emit("change");
  }

  private releaseTracks() {
    if (this.peerStream) {
      this.peerStream.getTracks().forEach((track) => {
        track.stop();
      });

      this._peerStream = undefined;
      this._peerAudio = undefined;
      this._peerVideo = undefined;
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        track.stop();
      });

      this._localStream = undefined;
      this._audioStream = undefined;
      this._videoStream = undefined;
    }
  }

  private clean(): void {
    logger.info(
      "[NEGOTIATION] Cleaning up PeerConnection to ",
      this.rtcPeerConnection
    );

    this.dataChannelOpen = false;
    this.listeningForNetworkChange = false;
    this.iceQueue = [];
    this._externalControls = undefined;

    const peerConnection = this.rtcPeerConnection;
    const dataChannel = this.dataChannel;

    if (dataChannel) {
      dataChannel.onclose = dataChannel.onerror = dataChannel.onopen = null;
      const validStates: RTCDataChannelState[] = ["closing", "closed"];
      if (validStates.indexOf(dataChannel.readyState) < 0) {
        logger.info("[NEGOTIATION] will close the data channel");
        dataChannel.close();
      } else {
        logger.info(
          "[NEGOTIATION] could not close the data channel, the state ===",
          dataChannel.readyState
        );
      }

      this.dataChannel = undefined;
    }

    if (peerConnection) {
      peerConnection.onicecandidate = null;
      peerConnection.ontrack = null;
      peerConnection.ondatachannel = null;
      peerConnection.onnegotiationneeded = null;
      peerConnection.onsignalingstatechange = null;
      peerConnection.oniceconnectionstatechange = null;
      peerConnection.onicegatheringstatechange = null;
      peerConnection.onconnectionstatechange = null;

      // ReactNative compatibility.
      if (!peerConnection.addTrack) {
        // @ts-ignore ReactNative compatibility.
        peerConnection.onaddstream = null;
      }

      if (peerConnection.connectionState !== "closed") {
        logger.info("[NEGOTIATION] will close the peer connection");
        peerConnection.close();
      } else {
        logger.info(
          "[NEGOTIATION] could not close the peer connection, the state ===",
          peerConnection.connectionState
        );
      }

      this.rtcPeerConnection = undefined;
    }
  }

  get finished(): boolean {
    return this._finished;
  }

  get audio(): boolean {
    return this.localStream?.getAudioTracks().some((t) => t.enabled) || false;
  }

  get video(): boolean {
    return this.localStream?.getVideoTracks().some((t) => t.enabled) || false;
  }

  get matched(): boolean {
    return this.dataChannelOpen;
  }

  get externalControls(): ExternalControls | undefined {
    return this._externalControls;
  }

  get localStream(): MediaStream | undefined {
    return this._localStream;
  }

  get peerStream(): MediaStream | undefined {
    return this._peerStream;
  }

  get peerVideo(): MediaStreamTrack[] | undefined {
    return this._peerVideo;
  }

  get peerAudio(): MediaStreamTrack[] | undefined {
    return this._peerAudio;
  }

  get connected(): boolean {
    return this.signaling.connected;
  }

  getDevices(): Promise<MediaDeviceInfo[]> {
    return Promise.resolve([]);
  }

  on<K extends keyof EventMap>(
    type: K,
    listener: (ev: EventMap[K]) => any
  ): void {
    this.emitter.on(type, listener);
  }

  off<K extends keyof EventMap>(
    type: K,
    listener: (ev: EventMap[K]) => any
  ): void {
    this.emitter.off(type, listener);
  }

  send(data: string): void;
  send(data: Blob): void;
  send(data: ArrayBuffer): void;
  send(data: ArrayBufferView): void;
  send(data: any): void {
    if (this.dataChannelOpen) {
      this.dataChannel?.send(data);
    }
  }

  async setActiveDevice(newDevice: MediaDeviceInfo): Promise<void> {
    switch (newDevice.kind) {
      case "videoinput":
        this._videoDevice = newDevice;
        break;
      case "audioinput":
        this._audioDevice = newDevice;
        break;
      case "audiooutput":
        throw new Error("could not change the audio output here");
    }

    return this.changeTracks();
  }

  async nextVideoDevice(): Promise<void> {
    // @ts-ignore React native has this method.
    if (this.localStream?.getVideoTracks()?.[0]?._switchCamera) {
      // @ts-ignore
      this.localStream?.getVideoTracks()[0]._switchCamera();
      this.emitter.emit("local-track-change");
      return;
    }

    const devices = await navigator.mediaDevices.enumerateDevices();

    if (this._videoDevice) {
      const videoDevices = devices.filter(
        (device) => device.kind === "videoinput"
      );
      if (
        videoDevices[videoDevices.length - 1].deviceId ===
        this._videoDevice.deviceId
      ) {
        this._videoDevice = videoDevices[0];
      } else {
        for (let index = 0; index < videoDevices.length - 1; index++) {
          const nextIndex = index + 1;
          if (
            videoDevices[index].deviceId === this._videoDevice.deviceId &&
            videoDevices[nextIndex].deviceId !== this._videoDevice.deviceId
          ) {
            this._videoDevice = videoDevices[nextIndex];
            break;
          }
        }
      }
    }

    return this.changeTracks();
  }

  private async changeTracks() {
    this.logConnectionsStates();

    if (this.rtcPeerConnection?.signalingState !== "stable") {
      await this.getMediaStream();
      logger.log(
        "the iceConnectionState does not require to replace the tracks"
      );
      return;
    }

    const supportReplaceTrack =
      this.rtcPeerConnection?.getSenders &&
      this.rtcPeerConnection?.getSenders()[0].replaceTrack;

    if (!supportReplaceTrack) {
      // @ts-ignore
      this.rtcPeerConnection?.removeStream(this.localStream);
      this.localStream?.getTracks().forEach((t) => t.stop());
      await this.getMediaStream();
      await this.addTracks();
      await this.createOffer({ restart: true });
      return;
    }

    await this.getMediaStream();

    this.rtcPeerConnection?.getSenders().forEach((sender) => {
      switch (sender.track?.kind) {
        case "video":
          if (this._videoStream) {
            sender.replaceTrack(this._videoStream);
          }
          break;
        case "audio":
          if (this._audioStream) {
            sender.replaceTrack(this._audioStream);
          }
          break;
      }
    });
  }

  async toggleAudio(): Promise<void> {
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = !t.enabled));
    this.sendControls();
    this.emitter.emit("change");
  }

  async toggleVideo(): Promise<void> {
    this.localStream?.getVideoTracks().forEach((t) => (t.enabled = !t.enabled));
    this.sendControls();
    this.emitter.emit("change");
  }

  private sendControls() {
    this.sendData({
      type: "ec",
      data: { audio: this.audio, video: this.video },
    });
  }

  private async onicecandidate(ev: RTCPeerConnectionIceEvent): Promise<any> {
    logger.debug("[ICE] onicecandidate", ev);

    if (ev.candidate) {
      this.signaling.sendICECandidate({
        candidate: ev.candidate,
        roomId: this.roomId as string,
      });
    }
  }

  private ontrack(ev: RTCTrackEvent): any {
    logger.debug("[COMMUNICATION] ontrack", ev);

    ev.track.onmute = () => {
      logger.info("[COMMUNICATION] track muted");
      this.emitter.emit("track-change");
    };
    ev.track.onunmute = () => {
      logger.info("[COMMUNICATION] track unmuted");
      this.emitter.emit("track-change");
    };
    ev.track.onended = () => {
      logger.info("[COMMUNICATION] ended");
      this.emitter.emit("track-change");
    };

    let streams: MediaStreamTrack[] = [];

    ev.streams.forEach(stream => {
      this._peerVideo = stream.getVideoTracks();
      this._peerAudio = stream.getAudioTracks();

      streams = streams.concat(this._peerVideo)
        .concat(this._peerAudio);
    });

    this._peerStream = new MediaStream(streams);
    this.emitter.emit("track-change");
  }

  private onaddstream(ev: MediaStreamEvent): any {
    logger.info("[COMMUNICATION] onaddstream", ev);

    if (ev.stream) {
      this._peerVideo = ev.stream.getVideoTracks();
      this._peerAudio = ev.stream.getAudioTracks();
      this._peerStream = ev.stream;
      this.emitter.emit("track-change");
    } else {
      logger.warn("[COMMUNICATION] the stream received is empty");
    }
  }

  private ondatachannel(ev: RTCDataChannelEvent): any {
    this.dataChannel = ev.channel;
    this.addDataChannelListeners(this.dataChannel);
  }

  private addDataChannelListeners(channel: RTCDataChannel): void {
    channel.onerror = (ev) => {
      logger.error("[COMMUNICATION] error in the data channel: ", ev.error);
      this.dataChannelOpen = false;
    };
    channel.onopen = () => {
      logger.info("[COMMUNICATION] data channel opened");
      this.dataChannelOpen = true;
      this.sendControls();
    };
    channel.onclose = () => {
      logger.info("[COMMUNICATION] data channel closed");
      this.dataChannelOpen = false;
    };
    channel.onmessage = (ev: MessageEvent) => {
      logger.info("[COMMUNICATION] new message", ev.data);

      try {
        const message = JSON.parse(ev.data);
        if (message.type === "ec") {
          this._externalControls = message.data;
          this.emitter.emit("change");
        } else {
          this.emitter.emit("message", message);
        }
      } catch (e) {
        logger.error(
          "[COMMUNICATION] error while trying to parse a message:",
          ev
        );
      }
    };
  }

  private async onnegotiationneeded(_: Event): Promise<any> {
    logger.info(
      "[ICE] negotiationneeded: ss:" + this.rtcPeerConnection?.signalingState
    );
    if (this.rtcPeerConnection?.signalingState === "stable") {
      this.createOffer();
    }
  }

  private async createOffer<K extends { restart: boolean }>(
    op?: K
  ): Promise<RTCSessionDescriptionInit> {
    const offer = await this.buildOffer(op);
    this.rtcPeerConnection?.setLocalDescription(offer);
    await this.signaling.sendSDPOffer({
      sdp: offer,
      roomId: this.roomId as string,
    });
    WebRTCCall.logSDP(offer);
    return offer;
  }

  private updateBandWidth(offer: RTCSessionDescriptionInit): void {
    if (this.bandwidth === "unlimited") {
      offer.sdp?.replace(/b=AS:.*\r\n/, "").replace(/b=TIAS:.*\r\n/, "");
    } else {
      WebRTCCall.updateBandwidthWithModifier(offer, "AS", this.bandwidth);
      // Firefox use it.
      WebRTCCall.updateBandwidthWithModifier(offer, "TIAS", this.bandwidth * 1000);
    }
  }

  private static updateBandwidthWithModifier(
    offer: RTCSessionDescriptionInit,
    modifier: "AS" | "TIAS",
    bandwidth: number
  ) {
      if (offer.sdp?.indexOf("b=" + modifier + ":") === -1) {
        // insert b= after c= line.
        offer.sdp = offer.sdp?.replace(
          /c=IN (.*)\r\n/,
          `c=IN $1\r
b=${modifier}:${bandwidth}\r
`
        );
      } else {
        offer.sdp = offer.sdp?.replace(
          new RegExp(`b=${modifier}:.*\r
`),
          `b=${modifier}:${bandwidth}\r
`
        );
      }
    }

  private static logSDP(offer: RTCSessionDescriptionInit) {
    logger.info(
      offer.sdp?.split("\r\n").map((x) => {
        const t = x.split("=");
        return { [t[0]]: t[1] };
      })
    );
  }

  private async oniceconnectionstatechange(ev: Event): Promise<any> {
    const state = (ev as any).iceConnectionState;

    logger.info(
      "[ICE] iceconnectionstatechange",
      state,
      this.rtcPeerConnection?.connectionState
    );

    switch (state) {
      case "connected":
        this.iceFailed = false;
        break;
      case "disconnected":
        logger.warn("[ICE] peers disconnected, but we still can reconnect");
          this.runDisconnectedStrategy();
        break;
      case "failed":
        if (this._finished) {
          break;
        }

        // The ICE candidate has checked all candidates pairs against one another and has failed to find compatible
        // matches for all components of the connection. It is, however, possible that the ICE agent did find
        // compatible connections for some components.
        if (!this.iceFailed) {
          logger.warn("[ICE] restarting the ice candidates");
          this.iceFailed = true;
          this.restartICE();
        } else {
          this.emitter.emit(
            "error",
            new CallError(
              "The connection is poor, please check your internet connection or try to connect to other network",
              ErrorCodes.POOR_CONNECTION_ERROR
            )
          );
        }
        break;
      case "closed":
        logger.info('[ICE] connection closed')
        break;
      default:
        logger.info("[ICE] unhandled ice connection state change: ", state);
        break;
    }

    this.emitter.emit("change");
  }

  private async needReconnection() {
    if (this.listeningForNetworkChange) {
      logger.info("[NEGOTIATION] already listening for network changes");
      return;
    }

    const isOnline = await this.network.isOnline({ timeout: 3000 });

    if (isOnline) {
      logger.warn('[COMMUNICATION] restarting the communication after little disconnection');
      await this.restartCall();
      return;
    }

    this.emitter.emit(
      "error",
      new CallError(
        "Check your internet connection",
        ErrorCodes.NO_INTERNET_ACCESS_ERROR
      )
    );

    const listener = async (online: boolean) => {
      if (online) {
        logger.warn('[COMMUNICATION] restarting the communication after network issue');
        await this.restartCall();

        this.network.off("change", listener);
      }
    };

    this.listeningForNetworkChange = true;
    this.network.on("change", listener);
  }

  private async restartCall() {
    this.clean();
    await this.start({
      mediaStreamConstrains: this
        .mediaStreamConstrains as MediaStreamConstraints,
      roomId: this.roomId as string,
    });
    await this.onNewPeer();
  }

  private async restartICE() {
    // @ts-ignore restartIce is not available in all the browsers.
    if (this.rtcPeerConnection?.restartIce) {
      // @ts-ignore
      this.rtcPeerConnection?.restartIce();
    } else {
      const offer = await this.buildOffer({restart: true});
      this.rtcPeerConnection?.setLocalDescription(offer);
      await this.signaling.sendSDPOffer({
        sdp: offer,
        roomId: this.roomId as string,
      });
    }
  }

  private async buildOffer<K extends { restart: boolean }>(
    op?: K
  ): Promise<RTCSessionDescriptionInit> {
    const offer = (await this.rtcPeerConnection?.createOffer({
      iceRestart: op?.restart,
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    })) as RTCSessionDescriptionInit;
    WebRTCCall.logSDP(offer);
    this.sanitizeSDP(offer);
    this.updateBandWidth(offer);
    return offer;
  }

  private onicegatheringstatechange(ev: Event): any {
    logger.info("[ICE] icegatheringstatechange", ev);

    switch (this.rtcPeerConnection?.iceGatheringState) {
      case "complete":
        if (!this.allowIceStalledChecking) {
          logger.debug(
            "[ICE] stalled ice checking disabled",
            this.rtcPeerConnection?.iceConnectionState
          );
          break;
        }
        setTimeout(async () => {
          if (this.rtcPeerConnection?.iceConnectionState === "checking" || this.rtcPeerConnection?.connectionState === 'connecting') {
            logger.warn(
              `[ICE] probably connection is stucked, ice takes 3s checking this iceConnectionState === ${this.rtcPeerConnection?.iceConnectionState} and the connectionState === ${this.rtcPeerConnection?.connectionState}`
            );
            await this.restartCall();
          } else {
            logger.debug(
              `[ICE] in the ice gathering check task did not need to restart the call because the new iceConnectionState is ${this.rtcPeerConnection?.iceConnectionState} and the connectionState is ${this.rtcPeerConnection?.connectionState}`
            );
          }
        }, 3000);
        break;
      default:
        logger.debug(
          "[ICE] unhandled iceGatheringState",
          this.rtcPeerConnection?.iceConnectionState
        );
    }
  }

  private async onsignalingstatechange(ev: Event): Promise<any> {
    logger.info("[NEGOTIATION] signalingstatechange", ev);
    if (this._finished) {
      return;
    }

    if (this.rtcPeerConnection?.remoteDescription) {
      const queueLength = this.iceQueue.length;

      for (let i = 0; i < queueLength; i++) {
        const candidate = this.iceQueue.pop();
        logger.debug(
          "[NEGOTIATION] Will add a new ice candidate from the queue",
          candidate
        );
        this.addIceCandidate(candidate as RTCIceCandidate);
      }
    }
  }

  private async onconnectionstatechange(): Promise<void> {
    switch (this.rtcPeerConnection?.connectionState) {
      case "connected":
        break;
      case "disconnected":
        logger.warn(
          "[NEGOTIATION] peers disconnected, but we still can reconnect"
        );
        break;
      case "failed":
        if (!this._finished) {
          logger.info('[NEGOTIATION] Connection failed, trying reconnection');
          this.needReconnection();
        }
        break;
      case "closed":
        break;
      default:
        logger.info(
          "[NEGOTIATION] unhandled ice connection state change: ",
          this.rtcPeerConnection?.connectionState
        );
        break;
    }
  }

  private sendData(msg: MessageContent) {
    if (this.dataChannel) {
      this.dataChannel.send(JSON.stringify(msg));
    } else {
      logger.warn(
        "[COMMUNICATION] could not send the given data because the data channel is empty",
        msg
      );
    }
  }

  private async addIceCandidate(ice: RTCIceCandidate) {
    try {
      await this.rtcPeerConnection?.addIceCandidate(
        new RTCIceCandidate({
          sdpMid: ice.sdpMid,
          sdpMLineIndex: ice.sdpMLineIndex,
          candidate: ice.candidate,
        })
      );
    } catch (e) {
      if (!ice.sdpMid && !ice.sdpMLineIndex) {
        logger.error("[ICE] sdpMid and sdpMLineIndex are empty");
        return;
      }

      const parsedRD = sdpTransform.parse(
        this.rtcPeerConnection?.remoteDescription?.sdp || ""
      );

      parsedRD.media.forEach((m) => {
        logger.debug("[ICE] ==========0");
        logger.debug(
          "[ICE] compare sdpMid incoming === remoteSession",
          ice.sdpMid,
          m.mid
        );
        logger.debug(
          "[ICE] compare ufrag incoming === remoteSession",
          ice.usernameFragment,
          m.iceUfrag
        );
      });

      logger.error("[ICE]", e);
    }
  }

  private sanitizeSDP(offer: RTCSessionDescriptionInit) {
    if (!this.allowSDPTransform) {
      return;
    }

    let newSDP: string | undefined;

    try {
      newSDP = sdpTransform.write(sdpTransform.parse(offer.sdp as string)) || offer.sdp;
      offer.sdp = newSDP;
    } catch (e) {
      // Browsers will not support sdp properties updates.
      logger.error(e);
    }
  }

  private logConnectionsStates() {
    logger.info(
      "[SIGNALING] signaling: " +
        this.rtcPeerConnection?.signalingState +
        " iceConnectionState: " +
        this.rtcPeerConnection?.iceConnectionState +
        " iceGatheringState: " +
        this.rtcPeerConnection?.iceGatheringState +
        " connectionState: " +
        this.rtcPeerConnection?.connectionState
    );
  }

  /**
   * If the bitrate has not increased in the las 4s we'll restart the ICE.
   * @private
   */
  private async runDisconnectedStrategy() {
    if (this.allowBitrateChecking) {
      return;
    }

    if (this.runninDisconnectionStrategy) {
      logger.warn("[COMMUNICATION] still runnig the disconnection strategy");
      return;
    }

    this.runninDisconnectionStrategy = true;

    const oldBitrate = await this.getBitRate();

    setTimeout(async () => {
      let bitRateDiff = 0;
      let oldValue = 0;

      if (this.video) {
        // Check our video stats.
        bitRateDiff = await this.brDiff(oldBitrate, "video", "output");
        oldValue = oldBitrate.video.output;
      } else if (this.externalControls?.video) {
        // Check external video stats.
        bitRateDiff = await this.brDiff(oldBitrate, "video", "input");
        oldValue = oldBitrate.video.input;
      } else if (this.audio) {
        // Check our audio stats.
        bitRateDiff = await this.brDiff(oldBitrate, "audio", "output");
        oldValue = oldBitrate.audio.output;
      } else if (this.externalControls?.audio) {
        // Check external audio stats.
        bitRateDiff = await this.brDiff(oldBitrate, "audio", "input");
        oldValue = oldBitrate.audio.input;
      }

      await this.checkDifferenceAndRestart(bitRateDiff, oldValue);
      this.runninDisconnectionStrategy = false;
    }, 4000);
  }

  private async getBitRate(): Promise<BitRateStats> {
    if (!this.bitRateLog) {
      this.bitRateLog = new Bitrate();
    }
    if (this.rtcPeerConnection) {
      return await this.bitRateLog.find(this.rtcPeerConnection);
    }

    return { video: { input: 0, output: 0 }, audio: { input: 0, output: 0 } };
  }

  async logBitRate() {
    if (this.rtcPeerConnection) {
      const br = await this.getBitRate();
      if (br) {
          logger.info(`[STATS] Video Bitrate in:${br.video.input}kb/s - out:${br.video.output}kb/s`);
          logger.info(`[STATS] Audio Bitrate in:${br.audio.input}kb/s - out:${br.audio.output}kb/s`);
      }
    }
  }

  private async brDiff(
    oldBitrate: BitRateStats,
    property: "video" | "audio",
    way: "input" | "output"
  ): Promise<number> {
    const currentBitrate = await this.getBitRate();
    return oldBitrate[property][way] - currentBitrate[property][way];
  }

  private async checkDifferenceAndRestart(
    difference: number,
    oldBitrate: number
  ): Promise<void> {
    if (difference < -100) {
      logger.warn(
        "[STATS] poor bit rate, will restart the ice candidates, difference " +
          `(${difference}) first:${oldBitrate}kbits/s current: ${
            difference + oldBitrate
          }kbits/s`
      );
      return this.restartICE();
    }
  }
}
