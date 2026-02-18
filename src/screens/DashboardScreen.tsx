import React from "react";
import { View, Text } from "react-native";
import FloatingButton from "../components/FloatingButton";

import { theme } from "../theme";

export default function DashboardScreen() {
	return (
		<View style={{ flex: 1 }}>
			<View
				style={{
					flex: 1,
					backgroundColor: theme.colors.background,
					padding: 16,
				}}
			>
				<Text
					style={[theme.typography.h2, { color: theme.colors.textPrimary }]}
				>
					Dashboard
				</Text>
			</View>

			<FloatingButton />
		</View>
	);
}
