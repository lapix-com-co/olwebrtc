import { ApolloLink, split } from "apollo-link";
import { WebSocketLink } from "apollo-link-ws";

const signalingOperations: string[] = [
  "sendSDPOffer",
  "sendSDPAnswer",
  "sendICECandidate",
  "finishCall",
  "onRoomInteraction",
];

export default function newCallClient(
  config: WebSocketLink.Configuration,
  currentClient?: ApolloLink
): ApolloLink {
  const wsLink = new WebSocketLink(config);

  if (!currentClient) {
    return wsLink;
  }

  return split(
    ({ operationName }) => signalingOperations.indexOf(operationName) >= 0,
    wsLink,
    currentClient
  );
}
