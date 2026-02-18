import React from "react";
import { View, Text } from "react-native";
import { theme } from "../theme";

const SuppliersScreen = () => {
	return (
		<View
			style={{ flex: 1, backgroundColor: theme.colors.background, padding: 16 }}
		>
			<Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
				Report Screen
			</Text>
		</View>
	);
};

export default SuppliersScreen;
