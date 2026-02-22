import React, { useState, useEffect } from "react";
import {
	View,
	Text,
	TextInput,
	TouchableOpacity,
	Image,
	Platform,
} from "react-native";
import { Picker } from "@react-native-picker/picker";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";
import { File, Directory, Paths } from "expo-file-system";
import { useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";

import { styles } from "@screens/AddEntryScreen/AddEntry.styles";
import { theme } from "@theme";
import { expenseCategories } from "@constants/categories";

import {
	addTransaction,
	updateTransaction,
	getDailyTransactionCount,
	checkExpenseSupplierSameDay,
} from "@database/transactionService";

import { getOrCreateSupplier, getSuppliers } from "@database/supplierService";

import { RootStackParamList } from "@navigation/types";
import {
	PAYMENT_OPTIONS,
	PaymentType,
	TransactionInput,
} from "src/types/transaction";

import { useToast } from "@context/ToastContext";
import { useFormDirty } from "src/hooks/useFormDirty";

type NavigationProp = NativeStackNavigationProp<RootStackParamList, "AddEntry">;

type Supplier = {
	id: number;
	name: string;
};

type Props = {
	editingTransaction: any;
	isEditMode: boolean;
	onSaveSuccess: () => void;
	setIsFormDirty: (value: boolean) => void;
};

export default function ExpenseForm({
	editingTransaction,
	isEditMode,
	onSaveSuccess,
	setIsFormDirty,
}: Props) {
	const navigation = useNavigation<NavigationProp>();
	const { show } = useToast();

	const [suppliers, setSuppliers] = useState<Supplier[]>([]);
	const [showDatePicker, setShowDatePicker] = useState(false);

	const initialValues = {
		amount: editingTransaction?.amount?.toString() ?? "",
		category: editingTransaction?.category ?? "",
		supplier: editingTransaction?.supplierName ?? "",
		paymentType: editingTransaction?.paymentType ?? "cash",
		note: editingTransaction?.note ?? "",
		date: editingTransaction?.date
			? new Date(editingTransaction.date)
			: new Date(),
		images: editingTransaction?.imagePath
			? JSON.parse(editingTransaction.imagePath)
			: [],
	};

	const [formValues, setFormValues] = useState(initialValues);

	const { isDirty, resetDirty } = useFormDirty(formValues);

	useEffect(() => {
		setIsFormDirty(isDirty);
	}, [isDirty]);

	useEffect(() => {
		if (!editingTransaction) return;

		const updatedValues = {
			amount: editingTransaction.amount?.toString() ?? "",
			category: editingTransaction.category ?? "",
			supplier: editingTransaction.supplierName ?? "",
			paymentType: editingTransaction.paymentType ?? "cash",
			note: editingTransaction.note ?? "",
			date: new Date(editingTransaction.date),
			images: editingTransaction.imagePath
				? JSON.parse(editingTransaction.imagePath)
				: [],
		};

		setFormValues(updatedValues);
		resetDirty(updatedValues);
	}, [editingTransaction]);

	useEffect(() => {
		const loadSuppliers = async () => {
			const data = await getSuppliers();
			setSuppliers(data as Supplier[]);
		};
		loadSuppliers();
	}, []);

	const handleChange = (key: keyof typeof formValues, value: any) => {
		setFormValues((prev) => ({
			...prev,
			[key]: value,
		}));
	};

	const formatDate = (date: Date) => {
		const y = date.getFullYear();
		const m = String(date.getMonth() + 1).padStart(2, "0");
		const d = String(date.getDate()).padStart(2, "0");
		return `${y}-${m}-${d}`;
	};

	const pickImage = async () => {
		if (formValues.images.length >= 7) {
			show("Maximum 7 images allowed", "info");
			return;
		}

		const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
		if (!permission.granted) {
			show("Permission required", "warning");
			return;
		}

		const result = await ImagePicker.launchImageLibraryAsync({
			mediaTypes: ["images"],
			quality: 0.7,
			allowsMultipleSelection: true,
			selectionLimit: 7 - formValues.images.length,
		});

		if (!result.canceled) {
			const billsDir = new Directory(Paths.document, "bills");

			if (!(await billsDir.exists)) {
				await billsDir.create({ intermediates: true });
			}

			const newPaths: string[] = [];

			for (const asset of result.assets) {
				const fileName = `bill_${Date.now()}_${Math.random()}.jpg`;
				const newFile = new File(billsDir, fileName);
				const sourceFile = new File(asset.uri);

				await sourceFile.copy(newFile);
				newPaths.push(newFile.uri);
			}

			handleChange("images", [...formValues.images, ...newPaths]);
		}
	};

	const removeImage = async (index: number) => {
		const file = new File(formValues.images[index]);
		await file.delete();

		handleChange(
			"images",
			formValues.images.filter((image: string, i: number) => i !== index),
		);
	};

	const handleSave = async () => {
		try {
			if (!formValues.amount || !formValues.category || !formValues.supplier) {
				show("Amount, Category and Supplier are required", "warning");
				return;
			}

			const numericAmount = Number(formValues.amount.trim());

			if (
				!Number.isFinite(numericAmount) ||
				numericAmount <= 0 ||
				numericAmount > 20000
			) {
				show("Enter a valid amount", "warning");
				return;
			}

			const formattedDate = formatDate(formValues.date);

			if (!isEditMode) {
				const count = await getDailyTransactionCount(formattedDate, "expense");
				if (count >= 12) {
					show("Maximum 12 expense entries allowed per day.", "warning");
					return;
				}
			}

			const supplierId = await getOrCreateSupplier(formValues.supplier);

			const existing = await checkExpenseSupplierSameDay(
				formattedDate,
				supplierId,
				editingTransaction?.id,
			);

			if (existing) {
				show(
					`${formValues.supplier.toUpperCase()} already exists for this date.`,
					"warning",
				);
				return;
			}

			const payload: TransactionInput = {
				type: "expense",
				amount: numericAmount,
				category: formValues.category,
				note: formValues.note || null,
				date: formattedDate,
				paymentType: formValues.paymentType,
				supplierId,
				imagePath:
					formValues.images.length > 0
						? JSON.stringify(formValues.images)
						: null,
			};

			if (isEditMode) {
				await updateTransaction(editingTransaction.id, payload);
				show("Transaction Updated", "success");
				onSaveSuccess();
				resetDirty();
				setIsFormDirty(false);
				navigation.goBack();
			} else {
				await addTransaction(payload);
				show("Transaction Saved", "success");

				const cleared = {
					amount: "",
					category: "",
					supplier: "",
					paymentType: "cash",
					note: "",
					date: new Date(),
					images: [],
				};

				setFormValues(cleared);
				resetDirty(cleared);
				setIsFormDirty(false);
				onSaveSuccess();
			}
		} catch (error) {
			console.log(error);
			show("Error saving transaction", "error");
		}
	};

	return (
		<>
			<Text style={styles.label}>Date</Text>
			<TouchableOpacity
				style={styles.input}
				onPress={() => setShowDatePicker(true)}
			>
				<Text>{formatDate(formValues.date)}</Text>
			</TouchableOpacity>

			{showDatePicker && (
				<DateTimePicker
					value={formValues.date}
					mode="date"
					display={Platform.OS === "ios" ? "spinner" : "default"}
					onChange={(e, date) => {
						setShowDatePicker(false);
						if (date) handleChange("date", date);
					}}
				/>
			)}

			<Text style={styles.label}>Amount</Text>
			<TextInput
				style={styles.amountInput}
				keyboardType="numeric"
				placeholder="₹ 0.00"
				value={formValues.amount}
				onChangeText={(val) => handleChange("amount", val)}
				placeholderTextColor={theme.colors.textSecondary}
			/>

			<Text style={styles.label}>Category</Text>
			<View style={styles.pickerWrapper}>
				<Picker
					selectedValue={formValues.category}
					onValueChange={(val) => handleChange("category", val)}
					style={{
						color: theme.colors.textPrimary,
					}}
					dropdownIconColor={theme.colors.textPrimary}
				>
					<Picker.Item label="Select Category" value="" />
					{expenseCategories.map((cat) => (
						<Picker.Item key={cat} label={cat} value={cat} />
					))}
				</Picker>
			</View>

			<Text style={styles.label}>Supplier</Text>
			<View style={styles.pickerWrapper}>
				<Picker
					selectedValue={formValues.supplier}
					onValueChange={(val) => handleChange("supplier", val)}
					style={{
						color: theme.colors.textPrimary,
					}}
					dropdownIconColor={theme.colors.textPrimary}
				>
					<Picker.Item label="Select Supplier" value="" />
					{suppliers.map((sup) => (
						<Picker.Item key={sup.id} label={sup.name} value={sup.name} />
					))}
				</Picker>
			</View>

			<Text style={styles.label}>Payment Type</Text>
			<View style={styles.paymentRow}>
				{PAYMENT_OPTIONS.map((p) => (
					<TouchableOpacity
						key={p}
						style={[
							styles.paymentButton,
							formValues.paymentType === p && styles.paymentActive,
						]}
						onPress={() => handleChange("paymentType", p)}
					>
						<Text
							style={[
								styles.paymentText,
								{
									color:
										formValues.paymentType === p
											? "#fff"
											: theme.colors.textPrimary,
								},
							]}
						>
							{p.toUpperCase()}
						</Text>
					</TouchableOpacity>
				))}
			</View>

			<Text style={styles.label}>Note</Text>
			<TextInput
				style={[styles.input, { height: 80 }]}
				placeholder="Optional note"
				value={formValues.note}
				onChangeText={(val) => handleChange("note", val)}
				placeholderTextColor={theme.colors.textSecondary}
				multiline
			/>

			<TouchableOpacity style={styles.imageButton} onPress={pickImage}>
				<Ionicons name="camera-outline" size={20} color="#fff" />
				<Text style={styles.imageButtonText}>
					Add Bill Images ({formValues.images.length}/7)
				</Text>
			</TouchableOpacity>

			<View style={styles.grid}>
				{formValues.images.map((img: string, index: number) => (
					<View key={index} style={styles.imageBox}>
						<Image source={{ uri: img }} style={styles.previewImage} />
						<TouchableOpacity
							style={styles.removeImageButton}
							onPress={() => removeImage(index)}
						>
							<Ionicons name="close" size={14} color="#fff" />
						</TouchableOpacity>
					</View>
				))}
			</View>

			<TouchableOpacity style={styles.saveButton} onPress={handleSave}>
				<Text style={styles.saveButtonText}>
					{isEditMode ? "Update Entry" : "Save Entry"}
				</Text>
			</TouchableOpacity>
		</>
	);
}
