import React from 'react';
import { Box, Text } from 'ink';

export function HomeEmptyState(): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={2} paddingX={2}>
      <Text>Nothing to show yet.</Text>
      <Text> </Text>
      <Text>  <Text color="cyan" bold>Ctrl-K</Text>       browse commands</Text>
      <Text>  <Text color="cyan" bold>/dm claude1</Text>  start a DM</Text>
      <Text>  <Text color="cyan" bold>/join #x</Text>     join or discover a room</Text>
      <Text>  <Text color="cyan" bold>1-9</Text>          jump to a sidebar entry</Text>
    </Box>
  );
}

export function DmEmptyState({ peer }: { peer: string }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>No messages yet.</Text>
      <Text> </Text>
      <Text>Say hi, or send a tagged message:</Text>
      <Text>  <Text color="cyan" bold>/dispatch {peer} &lt;text&gt;</Text></Text>
    </Box>
  );
}

export function RoomEmptyState({ room }: { room: string }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>No messages in {room} yet.</Text>
      <Text> </Text>
      <Text>  <Text color="cyan" bold>/broadcast {room} &lt;text&gt;</Text>   post to the room</Text>
      <Text>  <Text color="cyan" bold>/leave</Text>                     leave the room</Text>
    </Box>
  );
}
