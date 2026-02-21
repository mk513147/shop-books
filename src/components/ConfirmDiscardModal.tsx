import React from "react";
import { Modal, View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { theme } from "@theme";

type Props = {
	visible: boolean;
	onCancel: () => void;
	onConfirm: () => void;
};

export default function ConfirmDiscardModal({
	visible,
	onCancel,
	onConfirm,
}: Props) {
	return (
		<Modal transparent visible={visible} animationType="fade">
			<View style={styles.overlay}>
				<View style={styles.container}>
					<Text style={styles.title}>Discard current form?</Text>

					<Text style={styles.subtitle}>All entered data will be lost.</Text>

					<View style={styles.actions}>
						<TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
							<Text style={styles.cancelText}>Cancel</Text>
						</TouchableOpacity>

						<TouchableOpacity style={styles.confirmBtn} onPress={onConfirm}>
							<Text style={styles.confirmText}>Discard</Text>
						</TouchableOpacity>
					</View>
				</View>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	overlay: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.4)",
		justifyContent: "center",
		alignItems: "center",
	},
	container: {
		width: "85%",
		backgroundColor: theme.colors.card,
		borderRadius: 12,
		padding: 20,
	},
	title: {
		fontSize: 16,
		fontWeight: "600",
		color: theme.colors.textPrimary,
	},
	subtitle: {
		marginTop: 8,
		color: theme.colors.textSecondary,
	},
	actions: {
		flexDirection: "row",
		justifyContent: "flex-end",
		marginTop: 20,
	},
	cancelBtn: {
		marginRight: 16,
	},
	cancelText: {
		color: theme.colors.textSecondary,
	},
	confirmBtn: {},
	confirmText: {
		color: "#f05e5e",
		fontWeight: "600",
	},
});
