import { ApolloClient, gql, FetchResult } from "@apollo/client";
import { TinyEmitter } from "tiny-emitter";
import { DocumentNode } from "graphql";
import { Signaling, RoomInfo, SDPAnswer, SDPOffer, ICECandidate, SignalingEventMap } from "./signaling";
import logger from "./log";

export class GraphqlSignaling implements Signaling {
  private subscribed: boolean = false;
  private emitter: TinyEmitter = new TinyEmitter();
  private subscription?: ZenObservable.Subscription;

  // This timer ensures that the given connection will notify
  // that the current peer has been joined to the room.
  // This will send a message every 5 seconds to the backed
  // to check that it gets connected.
  private timer?: number;

  constructor(private apolloClient: ApolloClient<any>) {}

  get connected(): boolean {
    return this.subscribed;
  }

  async sendICECandidate(input: ICECandidate): Promise<RoomInfo> {
    const request = await this._send(
      gql`
        mutation($input: SendICECandidateInput!) {
          sendICECandidate(input: $input) {
            id
          }
        }
      `,
      {
        input: {
          iceCandidate: JSON.stringify(input.candidate),
          roomID: input.roomId,
        },
      }
    );

    return { id: request.data.sendICECandidate.id };
  }

  async joined(input: {roomId: string}): Promise<RoomInfo> {
    const request = await this._send(
      gql`
        mutation($input: JoinedInput!) {
          joined(input: $input) {
            id
          }
        }
      `,
      { input: { roomID: input.roomId } }
    );

    return { id: request.data.joined.id };
  }

  async sendSDPAnswer(input: SDPAnswer): Promise<RoomInfo> {
    const request = await this._send(
      gql`
        mutation($input: SendSDPAnswerInput!) {
          sendSDPAnswer(input: $input) {
            id
          }
        }
      `,
      { input: { sdp: JSON.stringify(input.sdp), roomID: input.roomId } }
    );

    return { id: request.data.sendSDPAnswer.id };
  }

  async sendSDPOffer(input: SDPOffer): Promise<RoomInfo> {
    const request = await this._send(
      gql`
        mutation($input: SendSDPOfferInput!) {
          sendSDPOffer(input: $input) {
            id
          }
        }
      `,
      { input: { sdp: JSON.stringify(input.sdp), roomID: input.roomId } }
    );

    return { id: request.data.sendSDPOffer.id };
  }

  async finish(input: RoomInfo): Promise<RoomInfo> {
    const request = await this._send(
      gql`
        mutation($input: FinishInput!) {
          finishCall(input: $input) {
            id
          }
        }
      `,
      { input: { roomID: input.id } }
    );

    return { id: request.data.finishCall.id };
  }

  async connect(input: RoomInfo): Promise<RoomInfo> {
    if (this.connected) {
      throw new Error("Already connected to the signaling server");
    }

    this.subscribed = true;

    const observer = this.apolloClient.subscribe({
      variables: { input: { roomID: input.id } },
      query: gql`
        subscription($input: RoomInteractionInput!) {
          onRoomInteraction(input: $input) {
            joined
            newPeer
            newOffer
            newAnswer
            newIceCandidate
            disconnected
            finished
          }
        }
      `,
    });

    logger.trace("[SIGNALING] Will try to connect to the server");

    this.subscription = observer.subscribe({
      next: (props: FetchResult<any>) => {
        const {data} = props;
        const content = data.onRoomInteraction;

        this.clearTimer();

        logger.debug("[SIGNALING] subscription next", data);

        if (content.joined) {
          this._dispatchEvent("newPeer", { id: JSON.parse(content.joined) });
        } else if (content.newPeer) {
          this._dispatchEvent("newPeer", { id: JSON.parse(content.newPeer) });
        }

        if (content.disconnected) {
          this._dispatchEvent("disconnect", {
            id: JSON.parse(content.disconnected),
          });
        }

        if (content.finished) {
          this._dispatchEvent("finished", {
            id: JSON.parse(content.finished),
          });
        }

        if (content.newOffer) {
          this._dispatchEvent("newOffer", {
            sdp: new RTCSessionDescription(JSON.parse(content.newOffer)),
            roomId: input.id,
          });
        }

        if (content.newAnswer) {
          this._dispatchEvent("newAnswer", {
            sdp: new RTCSessionDescription(JSON.parse(content.newAnswer)),
            roomId: input.id,
          });
        }

        if (content.newIceCandidate) {
          this._dispatchEvent("newIceCandidate", {
            candidate: JSON.parse(content.newIceCandidate),
            roomId: input.id,
          });
        }
      },
      error: (errorValue: any) => {
        logger.error("[SIGNALING] subscription error", errorValue);

        this.subscribed = false;
        this._dispatchEvent("error", errorValue);
        this._dispatchEvent("close", null);
        this.initializeTimer(input.id);
        this.joined({ roomId: input.id });
      },
      complete: () => {
        logger.info("[SIGNALING] subscription completed");

        this.subscribed = false;
        this._dispatchEvent("close", null);
      },
    }); 

    this.initializeTimer(input.id);

    this.joined({ roomId: input.id });

    return input;
  }

  async disconnect(input: RoomInfo): Promise<RoomInfo> {
    this.subscription?.unsubscribe();
    this.apolloClient?.stop();
    this.subscribed = false;
    this.clearTimer();
    return input;
  }

  off<K extends keyof SignalingEventMap>(
    type: K,
    listener: (ev: SignalingEventMap[K]) => any
  ): void {
    this.emitter.off(type, listener);
  }

  on<K extends keyof SignalingEventMap>(
    type: K,
    listener: (ev: SignalingEventMap[K]) => any
  ): void {
    this.emitter.on(type, listener);
  }

  _dispatchEvent<K extends keyof SignalingEventMap>(
    type: K,
    ev: SignalingEventMap[K]
  ): void {
    this.emitter.emit(type, ev);
  }

  _send(mutation: DocumentNode, variables: { [key: string]: any }) {
    return this.apolloClient.mutate({
      mutation,
      variables,
    });
  }

  private clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private initializeTimer(roomId: string) {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      logger.info('[SIGNALING] Did notify the backend about the connection status');

      this.joined({ roomId });
    }, 10000) as any;
  }
}
