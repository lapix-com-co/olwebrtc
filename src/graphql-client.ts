import { ApolloLink, split } from "@apollo/client";
import { WebSocketLink } from "@apollo/client/link/ws";
import {FieldNode, OperationDefinitionNode} from "graphql";

// Those operations will use the ws transport layer.
const signalingOperations: string[] = [
  "sendSDPOffer",
  "sendSDPAnswer",
  "sendICECandidate",
  "finishCall",
  "onRoomInteraction",
  "joined",
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
    ({query}) => {
      const defNode = query.definitions[0] as OperationDefinitionNode;
      if (!defNode) {
        return false;
      }
      const fieldNode = defNode.selectionSet.selections[0] as FieldNode;
      if (!fieldNode) {
        return false;
      }
      const operationName = fieldNode.name?.value;
      return signalingOperations.indexOf(operationName) >= 0;
    },
    wsLink,
    currentClient
  );
}
