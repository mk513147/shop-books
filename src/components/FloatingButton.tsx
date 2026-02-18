import React from "react";
import { TouchableOpacity, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { theme } from "../theme";

export default function FloatingButton() {
	const navigation: any = useNavigation();

	return (
		<TouchableOpacity
			style={styles.fab}
			onPress={() => navigation.navigate("AddEntry")}
			activeOpacity={0.8}
		>
			<Ionicons name="add" size={28} color="#fff" />
		</TouchableOpacity>
	);
}

const styles = StyleSheet.create({
	fab: {
		position: "absolute",
		bottom: 30,
		alignSelf: "center",
		backgroundColor: theme.colors.primary,
		width: 64,
		height: 64,
		borderRadius: 32,
		justifyContent: "center",
		alignItems: "center",
		elevation: 6,
	},
});
