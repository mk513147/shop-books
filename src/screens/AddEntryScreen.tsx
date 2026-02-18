import React from "react";
import { View, Text } from "react-native";
import { theme } from "../theme";

export default function AddEntryScreen() {
	return (
		<View
			style={{
				flex: 1,
				backgroundColor: theme.colors.background,
				padding: 16,
			}}
		>
			<Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
				Add Entry
			</Text>
		</View>
	);
}
