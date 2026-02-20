import { StyleSheet } from "react-native";
import { theme } from "../../theme";

export const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: theme.colors.backgroundDark ?? "rgba(0,0,0,0.95)",
		justifyContent: "center",
		alignItems: "center",
	},
	image: {
		width: "100%",
		height: "75%",
	},
	closeButton: {
		position: "absolute",
		top: 50,
		right: 20,
	},
	closeText: {
		...theme.typography.bodyLarge,
		color: theme.colors.background,
		fontSize: 22,
	},
	indexText: {
		position: "absolute",
		bottom: 40,
		...theme.typography.body,
		color: theme.colors.textPrimary,
	},
	prevButton: {
		position: "absolute",
		left: 20,
		top: "50%",
	},

	nextButton: {
		position: "absolute",
		right: 20,
		top: "50%",
	},

	navText: {
		fontSize: 40,
		color: "#fff",
	},
});
