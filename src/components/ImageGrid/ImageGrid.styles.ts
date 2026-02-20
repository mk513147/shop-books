import { StyleSheet } from "react-native";
import { theme } from "@theme";

export const styles = StyleSheet.create({
	row: {
		flexDirection: "row",
		marginTop: 8,
	},
	wrapper: {
		marginRight: 6,
	},
	thumbnail: {
		width: 60,
		height: 60,
		borderRadius: 8,
	},
	overlay: {
		position: "absolute",
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		backgroundColor: "rgba(0,0,0,0.6)",
		justifyContent: "center",
		alignItems: "center",
		borderRadius: 8,
	},
	overlayText: {
		...theme.typography.body,
		color: theme.colors.textPrimary,
		fontWeight: "bold",
	},
});
