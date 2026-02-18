import React from "react";
import { View, Text } from "react-native";
import { theme } from "../theme";

function TransactionsScreen() {
	return (
		<View
			style={{ flex: 1, backgroundColor: theme.colors.background, padding: 16 }}
		>
			<Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
				Transactions Screen
			</Text>
		</View>
	);
}

export default TransactionsScreen;
