declare interface RoomInfo {
  id: string;
}

declare interface SignalingEventMap {
  /** The connection has been established with the signaling server */
  open: null;
  close: null;

  /** A new peer has been open. */
  newPeer: RoomInfo;
  /** Some peer has been disconnect from the signaling server. */
  disconnect: RoomInfo;
  /** The session has been finished */
  finished: RoomInfo;
  /** Some peer did a new RTCSession offer. */
  newOffer: SDPOffer;
  /** Some peer did answer the RTCSession offer */
  newAnswer: SDPAnswer;
  /** Some peer added a new ICE Candidate */
  newIceCandidate: ICECandidate;
  /** Any error in the peer connection */
  error: Error;
}

declare interface SDPOffer {
  sdp: RTCSessionDescriptionInit;
  roomId: string;
}

declare interface SDPAnswer {
  sdp: RTCSessionDescriptionInit;
  roomId: string;
}

declare interface ICECandidate {
  candidate: RTCIceCandidate;
  roomId: string;
}

declare interface Signaling {
  /**
   * Has the connection with the server been established.
   */
  readonly connected: boolean;
  /**
   * Connects to the signaling server.
   * @param input
   */
  connect(input: RoomInfo): Promise<RoomInfo>;
  /**
   * Disconnect from the signaling server.
   * @param input
   */
  disconnect(input: RoomInfo): Promise<RoomInfo>;
  /**
   * @param input
   */
  finish(input: RoomInfo): Promise<RoomInfo>;
  /**
   * Send a SDP Offer to the other peer.
   * @param input
   */
  sendSDPOffer(input: SDPOffer): Promise<RoomInfo>;
  /**
   * Send a SDP Answer to the other peer.
   * @param input
   */
  sendSDPAnswer(input: SDPAnswer): Promise<RoomInfo>;
  /**
   * Send an ICECandidate to the other peer.
   * @param input
   */
  sendICECandidate(input: ICECandidate): Promise<RoomInfo>;

  on<K extends keyof SignalingEventMap>(
    type: K,
    listener: (ev: SignalingEventMap[K]) => any
  ): void;

  off<K extends keyof SignalingEventMap>(
    type: K,
    listener: (ev: SignalingEventMap[K]) => any
  ): void;
}
