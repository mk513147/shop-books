import { StyleSheet } from "react-native";
import { theme } from "@theme";

export const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: theme.colors.background,
		padding: 16,
	},

	monthLabel: {
		fontSize: 18,
		fontWeight: "600",
		marginBottom: 12,
		color: theme.colors.textPrimary,
	},

	summaryRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		marginBottom: 12,
	},

	card: {
		flex: 1,
		backgroundColor: theme.colors.card,
		padding: 14,
		borderRadius: 10,
		marginHorizontal: 4,
	},

	cardFull: {
		backgroundColor: theme.colors.card,
		padding: 14,
		borderRadius: 10,
		marginBottom: 16,
	},

	label: {
		fontSize: 14,
		color: theme.colors.textSecondary,
	},

	value: {
		fontSize: 20,
		fontWeight: "700",
		marginTop: 6,
	},

	sectionTitle: {
		fontSize: 16,
		fontWeight: "600",
		marginBottom: 8,
		marginTop: 10,
		color: theme.colors.textPrimary,
	},

	breakdownText: {
		fontSize: 14,
		marginVertical: 4,
		color: theme.colors.textPrimary,
	},
});
