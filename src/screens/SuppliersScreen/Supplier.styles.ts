import { StyleSheet } from "react-native";
import { theme } from "@theme";

export const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: theme.colors.background,
		padding: 16,
	},

	card: {
		backgroundColor: theme.colors.card,
		padding: 16,
		borderRadius: 10,
		marginBottom: 12,
	},

	row: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
	},

	name: {
		fontSize: 16,
		fontWeight: "600",
		color: theme.colors.textPrimary,
	},

	due: {
		fontSize: 16,
		fontWeight: "700",
	},

	status: {
		marginTop: 6,
		fontSize: 13,
		color: theme.colors.textSecondary,
	},
});
